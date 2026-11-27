# Security Policy

## Supported versions

Only the latest version of the app published in the [Homey App Store](https://homey.app/a/com.hoymiles.hione) receives security fixes. Older versions are not patched; update the app in Homey to get a fix.

## Reporting a vulnerability

**Please do not report security issues in public issues, discussions or pull requests.**

Report them privately through GitHub instead:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue. Helpful to include:
   - the app version (Homey → Apps → Hoymiles HiOne),
   - the connection type: local Modbus TCP (port 502), native Hoymiles protocol (port 10081), or cloud only,
   - steps to reproduce, and what an attacker could do with it.

Do not include your S-Miles Cloud password, tokens or other secrets in the report.

This is a single-maintainer community project. I aim to acknowledge a report within two weeks and to agree on a fix and a disclosure date with you. If you want to be credited in the release notes, say so in the report.

## Scope

In scope, as part of this app:

- handling of S-Miles Cloud credentials and tokens,
- the app's web API used by the settings page and widget (`api.js`),
- writes to the battery over Modbus or the cloud that bypass the app's own range checks,
- the local network scan used to find the DTS stick,
- the app's dependencies and its GitHub Actions workflows.

Out of scope, please report these to the vendor instead:

- the HiOne inverter, the DTS stick firmware and the S-Miles Cloud: **Hoymiles**,
- Homey Pro and the Homey platform: **Athom**.

### Known limitation: Modbus TCP has no authentication

The DTS stick accepts Modbus TCP on port 502 from any device on the local network, without a password. That is how the stick works, not something this app can change: anything on the same network can read and change battery settings. Keep the stick on a trusted network, or on a separate VLAN that only Homey can reach, and do not forward port 502 to the internet.
