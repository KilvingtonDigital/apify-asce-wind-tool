# ASCE Hazard Tool Wind Speed Scraper

This Apify Actor automates the retrieval of wind speed data from the [ASCE 7 Hazard Tool](https://ascehazardtool.org/). 

It is designed to be easily integrated into other tools (like **Fastfield Forms/Fortiforms**, **Zapier**, or **n8n**) via the Apify API.

## Features
- **Automated Lookup:** Bypasses complex UI interactions (popups, map selections).
- **Robustness:** Handles network delays and site loading issues.
- **Specific Data:** Extracts the "Vmph" wind speed for Risk Category II (Wind Load).

## Input
The actor accepts a simple JSON input:

```json
{
    "address": "411 Crusaders Dr, Sanford, North Carolina, 27330"
}
```

## Output
The actor produces a JSON output:

```json
{
    "address": "411 Crusaders Dr, Sanford, North Carolina, 27330",
    "wind_speed": "114 Vmph",
    "status": "success"
}
```

## API Usage
You can run this actor programmatically. 

**POST** `https://api.apify.com/v2/acts/[YOUR_ACTOR_NAME]/run-sync-get-dataset-items?token=[YOUR_APIFY_TOKEN]`

**Body:**
```json
{ "address": "Your Address Here" }
```
