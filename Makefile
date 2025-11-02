UUID := uptime-kuma-indicator@uptime.dumke.me
EXT_DIR := uptime-kuma-indicator
PACKAGE := $(UUID).shell-extension.zip
EXTRA_FILES := prefs.js stylesheet.css LICENSE README.md
EXTRA_DIRS := utils
LOCALE_DIR := locale
SCHEMA_DIR := schemas

.PHONY: pack install clean

pack: clean
	@echo "Packing extension into $(PACKAGE)"
	cd "$(EXT_DIR)" && gnome-extensions pack --force --podir=$(LOCALE_DIR) $(foreach file,$(EXTRA_FILES),--extra-source=$(file)) $(foreach dir,$(EXTRA_DIRS),--extra-source=$(dir)) .
	mv "$(EXT_DIR)/$(PACKAGE)" .
	@echo "Package created: $(PACKAGE)"

install: pack
	@echo "Installing extension from $(PACKAGE)"
	gnome-extensions install --force "$(PACKAGE)"
	@echo "Extension installed. Reload GNOME Shell to apply changes."

clean:
	@echo "Removing packaged extension $(PACKAGE)"
	rm -f "$(PACKAGE)"
	rm -f "$(EXT_DIR)/$(PACKAGE)"
