# Service Selection Feature

## Overview
Added the ability to select up to 4 specific services from your Uptime Kuma instance to monitor in the GNOME Shell indicator.

## Changes Made

### 1. Schema Updates (`schemas/org.gnome.shell.extensions.kuma.gschema.xml`)
- Added new `selected-services` key to store an array of service IDs (as strings)
- Default value is an empty array `[]`, which means all services are monitored

### 2. Preferences UI (`prefs.js`)
- Added new "Service Selection" group in preferences
- Includes a "Fetch Services" button to load available services from your Uptime Kuma instance
- Provides 4 dropdown menus to select specific services
- Each dropdown shows service name and ID (e.g., "My Website (ID: 123)")
- Supports both status page (public) and private API modes
- Shows loading state while fetching services
- Displays errors via toast notifications if available

### 3. Extension Logic (`extension.js`)
- Modified `_loadSettings()` to load the selected services array
- Updated `_bindSettings()` to watch for changes to `selected-services`
- Enhanced `_refresh()` to filter monitors based on selected services
- If no services are selected (empty array), all monitors are displayed (default behavior)
- If services are selected, only those specific monitors are shown

## How to Use

1. Open the extension preferences
2. Configure your Uptime Kuma connection settings (Base URL, API mode, etc.)
3. Go to the "Service Selection" section
4. Click the "Fetch Services" button to load available services
5. Select up to 4 services from the dropdown menus
6. The indicator will automatically refresh and show only the selected services

## Technical Details

- Service IDs are stored as strings in GSettings
- Maximum of 4 services can be selected at once
- Filtering happens client-side after fetching all monitors
- Selection persists across GNOME Shell restarts
- Compatible with both status page JSON and private API modes

## Files Modified

- `schemas/org.gnome.shell.extensions.kuma.gschema.xml`
- `prefs.js`
- `extension.js`

## Testing

To test the feature:
1. Compile the schemas: `glib-compile-schemas schemas/`
2. Reload the GNOME Shell extension
3. Open preferences and test the fetch/select functionality
4. Verify that the indicator shows only the selected services
