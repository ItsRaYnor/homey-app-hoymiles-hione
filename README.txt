Monitor and control your Hoymiles HiOne all-in-one battery storage system from Homey.

FEATURES
- Real-time monitoring: PV power, battery state-of-charge, battery charge/discharge power, grid import/export and home load
- Energy totals: daily yield and lifetime total
- Battery mode control via Flows: Self-Consumption, Economy, Backup, Off-Grid, Peak Shaving, Time of Use
- Flow conditions: battery is/is not charging, grid is/is not importing, battery mode is/is not, connection is/is not local
- Three connection modes: Local (LAN), Local + Cloud (recommended), or Cloud only

REQUIREMENTS
- Homey Pro (2019 or 2023) with firmware >= 5.0.0
- Hoymiles HiOne all-in-one BESS with HiBox-63T-G3 gateway
- For cloud/hybrid mode: an active S-Miles Cloud account
- For local mode: the IP address of the HiBox gateway on your LAN

ADDING A DEVICE
1. Open the Homey app and go to Devices
2. Tap + and search for "Hoymiles HiOne"
3. Select HiOne Station
4. Choose your connection mode:
   - Local (LAN): enter the IP address of your HiBox gateway
   - Local + Cloud: enter the gateway IP, then log in with your S-Miles Cloud credentials
   - Cloud only: log in with your S-Miles Cloud email and password
5. Select your station from the list
6. Data refreshes every 60 seconds

FINDING YOUR HIBOX IP ADDRESS
Check your router's admin page under connected devices. Look for a device named DTUBI-... or HiBox.
Tip: use Local + Cloud for the most reliable experience.

FLOW CARDS
Actions:
- Set battery mode (Self-Consumption, Economy, Backup, Off-Grid, Peak Shaving, Time of Use)

Conditions:
- Battery is/is not charging
- Grid is/is not importing power
- Battery mode is/is not a specific mode
- Connection is/is not local (LAN)

DISCLAIMER
This is an unofficial, community-developed integration. Not affiliated with or endorsed by Hoymiles Power Electronics Inc. Uses the reverse-engineered S-Miles Cloud API and/or local DTU communication. Hoymiles may change these interfaces at any time. Use at your own risk.
