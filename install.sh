#!/usr/bin/env bash
# Installs Monitor Input & Brightness:
#   curl -fsSL https://raw.githubusercontent.com/cezou/monitor-input-brightness/main/install.sh | bash
set -euo pipefail

UUID="monitor-input-brightness@cezou.github.io"
RAW="https://raw.githubusercontent.com/cezou/monitor-input-brightness/main"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

step() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

if ! command -v ddcutil >/dev/null; then
    step "Installing ddcutil"
    if   command -v apt-get >/dev/null; then sudo apt-get install -y ddcutil
    elif command -v dnf     >/dev/null; then sudo dnf install -y ddcutil
    elif command -v pacman  >/dev/null; then sudo pacman -S --noconfirm ddcutil
    elif command -v zypper  >/dev/null; then sudo zypper install -y ddcutil
    else echo "Install ddcutil with your package manager, then re-run." >&2; exit 1
    fi
fi

# ddcutil talks to monitors through /dev/i2c-*, which needs the i2c-dev module
# and membership of the i2c group.
if [ ! -e /dev/i2c-0 ]; then
    step "Loading the i2c-dev kernel module"
    sudo modprobe i2c-dev
    echo i2c-dev | sudo tee /etc/modules-load.d/i2c-dev.conf >/dev/null
fi
need_relogin_group=false
if getent group i2c >/dev/null && ! id -nG "$USER" | grep -qw i2c; then
    step "Adding $USER to the i2c group"
    sudo usermod -aG i2c "$USER"
    need_relogin_group=true
fi

step "Installing the extension to $DEST"
mkdir -p "$DEST"
for f in metadata.json extension.js; do
    curl -fsSL "$RAW/$f" -o "$DEST/$f"
done

step "Enabling the extension"
gsettings set org.gnome.shell disable-user-extensions false
# gnome-extensions enable only knows extensions loaded by the running shell,
# so add it to the enabled list directly; it loads at next login.
enabled=$(gsettings get org.gnome.shell enabled-extensions)
if [[ "$enabled" != *"$UUID"* ]]; then
    if [[ "$enabled" == "@as []" || "$enabled" == "[]" ]]; then
        gsettings set org.gnome.shell enabled-extensions "['$UUID']"
    else
        gsettings set org.gnome.shell enabled-extensions "${enabled%]}, '$UUID']"
    fi
fi

echo
echo "Done. Log out and back in to see the monitor icon in the top bar."
$need_relogin_group && echo "(The logout also applies your new i2c group membership.)"
true
