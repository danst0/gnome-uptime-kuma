UUID := uptime-kuma-indicator@dumke
PACKAGE := $(UUID).shell-extension.zip
EXTRA_FILES := prefs.js stylesheet.css LICENSE README.md messages.mo
EXTRA_DIRS := utils docs
LOCALE_DIR := locale
SCHEMA_DIR := schemas

.PHONY: pack install clean compile-schemas

pack: compile-schemas clean
	@echo "Packing extension into $(PACKAGE)"
	gnome-extensions pack --force --podir=$(LOCALE_DIR) $(foreach file,$(EXTRA_FILES),--extra-source=$(file)) $(foreach dir,$(EXTRA_DIRS),--extra-source=$(dir)) .
	zip -qur "$(PACKAGE)" "$(LOCALE_DIR)" "$(SCHEMA_DIR)/gschemas.compiled"
	@echo "Package created: $(PACKAGE)"

install: pack
	@echo "Installing extension from $(PACKAGE)"
	gnome-extensions install --force "$(PACKAGE)"
	@echo "Extension installed. Reload GNOME Shell to apply changes."

clean:
	@echo "Removing packaged extension $(PACKAGE)"
	rm -f "$(PACKAGE)"

compile-schemas:
	@echo "Compiling GSettings schemas"
	glib-compile-schemas "$(SCHEMA_DIR)"
