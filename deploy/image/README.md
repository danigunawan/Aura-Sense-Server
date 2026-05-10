# AuraSense NVR — Golden image workflow

Three steps to deploy a new customer NVR from a pre-baked image:

| Step | Where | Time |
|------|-------|------|
| 1. Bake the image (one time, on a "blueprint" box) | Source box, booted from Ubuntu live USB | ~10 min |
| 2. Flash to new box | New box, booted from Ubuntu live USB | ~5–10 min |
| 3. Customize for the customer | New box, after first boot | ~5 min interactive |

Total per-customer time: **~15 min**, vs ~45 min for a from-scratch `install-all.sh`.

## What's in the bundle

`make-image.sh` produces four files sharing a common basename (e.g. `aurasense-base-20260511`):

| File | What | Size |
|------|------|------|
| `*.img.zst`     | ext4 root, **used blocks only**, partclone + zstd -19 | ~5–8 GB |
| `*.partlayout`  | GPT partition table backup (sgdisk)                   | < 1 KB |
| `*.bios.bin`    | BIOS-boot partition (sda1)                            | 1 MB |
| `*.efi.bin`     | EFI System Partition (sda2)                           | ~513 MB |

Free space in the source filesystem is **not** captured — partclone walks ext4 metadata and emits only allocated blocks, so a 500 GB SSD with 14 GB used yields a ~5–8 GB compressed image.

## 1. Bake — on the source box

The image must be created from a **live USB session** (the root filesystem can't be cleanly imaged while mounted). Plug an Ubuntu live USB into the source box and boot from it. From the live session:

```bash
sudo apt update
sudo apt install -y partclone zstd gdisk e2fsprogs

# Mount a USB stick where the bundle will land — e.g. /mnt/usb
sudo mkdir -p /mnt/usb
sudo mount /dev/sdX1 /mnt/usb   # whichever device is your USB stick

# Mount the source's root partition so we can read the imaging script.
sudo mkdir -p /mnt/src
sudo mount /dev/sda3 /mnt/src

sudo bash /mnt/src/home/aura/Documents/aurasense/deploy/image/make-image.sh \
    --out /mnt/usb/aurasense-base-$(date +%Y%m%d)

# Unmount the source again before powering off so make-image's checks pass.
# (If your live session auto-mounted sda3, you'll need to unmount it before
# running make-image.sh — the script refuses to image a mounted partition.)
```

Copy all four output files to your bench / shared storage. Treat the bundle as **private** — it contains the source customer's secrets, API keys, and `cameras.db`. The customization step on the new box overwrites all of it before any service starts, but until then the bytes are there.

## 2. Flash — on the new box

Boot the new box from the same Ubuntu live USB. Plug in the USB stick with the bundle.

```bash
sudo apt update
sudo apt install -y partclone zstd gdisk e2fsprogs parted

sudo mount /dev/sdX1 /mnt/usb

sudo bash /mnt/usb/restore-image.sh /dev/sda /mnt/usb/aurasense-base-20260511
```

The script:

1. Wipes `/dev/sda` (with explicit confirmation).
2. Recreates the GPT partition table; the root partition is **extended** to fill whatever size disk you're flashing onto.
3. Restores the BIOS-boot and EFI partitions byte-for-byte (so the bootloader UUID and grub config remain valid).
4. Restores the ext4 root with `partclone.ext4`.
5. Runs `resize2fs` to grow the filesystem into the larger partition.

When done, remove the USB and reboot into the new system.

## 3. Customize — after first boot

The new box now boots into an exact clone of the source: same hostname, same SSH host keys, same `.env` secrets, same Cloudflare tunnel cert, same `cameras.db`. The `firstboot.sh` script replaces every piece of that with fresh per-customer state.

Log in as `aura` (use the source box's password). Then:

```bash
sudo bash /home/aura/Documents/aurasense/deploy/firstboot.sh
```

You'll be prompted for:

- **Hostname** for this new box (default `aurasense-nvr`).
- **Cloudflare domain** for this customer (e.g. `site2.example.com`).
- **Camera ONVIF/RTSP password** (same on all this customer's cameras).
- **Dashboard admin password** (sets the default login).

The script then:

- Regenerates `/etc/machine-id`, SSH host keys, hostname.
- Wipes `cameras.db`, `/etc/cloudflared/`, `/root/.cloudflared/`, `dnsmasq.leases`.
- Rotates `API_SECRET_KEY`, `APP_SECRET`, `SIGNALING_JWT_SECRET` in all `.env` files.
- Sets `MEDIAMTX_HLS_URL` / `MEDIAMTX_URL` to `https://stream.<domain>` / `https://webrtc.<domain>`.
- Sets `NVR_DEVICE_ID` to the new box's camera-NIC MAC.
- Re-runs `00-netplan.sh` (auto-detects this box's NICs) and `00b-camera-dhcp.sh`.
- Detects and formats the recording HDD via `04-hdd-setup.sh` (gets a new fstab UUID).
- Runs `07-cloudflare.sh` — **interactive**, requires you to complete a browser-based `cloudflared tunnel login` on a separate machine.
- Restarts `aurasense.target`, then verifies via `08-verify.sh`.

The script is **idempotent**:

- `--resume` retries phases that didn't finish (sentinel files in `/var/lib/aurasense-firstboot/`).
- `--force` re-runs everything from scratch.
- Without flags, refuses to run a second time after completion.

For unattended runs you can supply all answers up-front:

```bash
sudo bash deploy/firstboot.sh \
    --hostname    site2-nvr \
    --domain      site2.example.com \
    --onvif-pass  'CameraPass123' \
    --admin-pass  'AdminPass123'
```

## Troubleshooting

**The new box doesn't boot:**

If UEFI doesn't pick up the cloned EFI partition (rare — some boards demand a fresh NVRAM entry):

```bash
# From an Ubuntu live USB:
sudo mount /dev/sda2 /mnt
sudo efibootmgr -c -d /dev/sda -p 2 -L "AuraSense" -l "\EFI\ubuntu\shimx64.efi"
sudo umount /mnt
```

**`make-image.sh` refuses, saying `/dev/sda` is mounted:**

You're still booted from the source disk. Boot from a live USB instead.

**Target disk is smaller than 32 GB:**

`restore-image.sh` refuses by design. The OS + venvs use ~14 GB, so 32 GB is the practical minimum. Use a larger disk.

**`firstboot.sh` interrupted mid-run:**

```bash
sudo bash deploy/firstboot.sh --resume
```

Phases that already completed are skipped (sentinel files in `/var/lib/aurasense-firstboot/`).

**Need to re-run everything (e.g. wrong customer domain entered):**

```bash
sudo bash deploy/firstboot.sh --force
```

This re-runs every phase and overwrites any prior config.
