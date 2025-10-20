UUID := uptime-kuma-indicator@dumke
EXTENSION_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
COPY_ITEMS := extension.js prefs.js metadata.json stylesheet.css LICENSE README.md utils locale schemas docs

.PHONY: install compile-schemas clean

install: clean
	@echo "Installing extension into $(EXTENSION_DIR)"
	install -d "$(EXTENSION_DIR)"
	cp -r $(COPY_ITEMS) "$(EXTENSION_DIR)"
	$(MAKE) compile-schemas
	@echo "Extension installed. Reload GNOME Shell to apply changes."

compile-schemas:
	@echo "Compiling GSettings schemas"
	rm -f "$(EXTENSION_DIR)/schemas/gschemas.compiled"
	glib-compile-schemas "$(EXTENSION_DIR)/schemas"

clean:
	@echo "Removing previous install at $(EXTENSION_DIR)"
	rm -rf "$(EXTENSION_DIR)"
