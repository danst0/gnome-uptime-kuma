UUID := uptime-kuma-indicator@uptime.dumke.me
EXT_DIR := uptime-kuma-indicator
PACKAGE := $(UUID).shell-extension.zip
EXTRA_FILES := prefs.js stylesheet.css LICENSE README.md
EXTRA_DIRS := utils locale
LOCALE_DIR := locale
LOCALE_BACKUP := /tmp/uptime-kuma-locale-backup
SCHEMA_DIR := schemas
PO_FILES := $(wildcard $(EXT_DIR)/$(LOCALE_DIR)/*/LC_MESSAGES/*.po)
MO_FILES := $(PO_FILES:.po=.mo)
VERSION := $(shell grep -Po '"version":\s*\K\d+' $(EXT_DIR)/metadata.json)

.PHONY: pack install clean translations release tag-release

translations: $(MO_FILES)

%.mo: %.po
	@echo "Compiling translation: $<"
	msgfmt $< -o $@

pack: translations clean
	@echo "Backing up .po and .pot files..."
	@rm -rf "$(LOCALE_BACKUP)"
	@mkdir -p "$(LOCALE_BACKUP)"
	@cd "$(EXT_DIR)/$(LOCALE_DIR)" && \
		if [ -f uptime-kuma-indicator.pot ]; then \
			cp uptime-kuma-indicator.pot "$(LOCALE_BACKUP)/" && rm uptime-kuma-indicator.pot; \
		fi
	@cd "$(EXT_DIR)/$(LOCALE_DIR)" && \
		for po in */LC_MESSAGES/*.po; do \
			if [ -f "$$po" ]; then \
				mkdir -p "$(LOCALE_BACKUP)/$$(dirname $$po)" && \
				cp "$$po" "$(LOCALE_BACKUP)/$$po" && \
				rm "$$po"; \
			fi; \
		done
	@echo "Packing extension into $(PACKAGE)"
	cd "$(EXT_DIR)" && gnome-extensions pack --force $(foreach file,$(EXTRA_FILES),--extra-source=$(file)) $(foreach dir,$(EXTRA_DIRS),--extra-source=$(dir)) .
	@echo "Restoring .po and .pot files..."
	@cp -r "$(LOCALE_BACKUP)"/* "$(EXT_DIR)/$(LOCALE_DIR)/" 2>/dev/null || true
	@rm -rf "$(LOCALE_BACKUP)"
	mv "$(EXT_DIR)/$(PACKAGE)" .
	@echo "Package created: $(PACKAGE)"
	@echo "✓ Only .mo files included in package (not .po or .pot)"

install: pack
	@echo "Installing extension from $(PACKAGE)"
	gnome-extensions install --force "$(PACKAGE)"
	@echo "Extension installed. Reload GNOME Shell to apply changes."

clean:
	@echo "Removing packaged extension $(PACKAGE)"
	rm -f "$(PACKAGE)"
	rm -f "$(EXT_DIR)/$(PACKAGE)"

# Create a GitHub release (requires gh CLI)
release: pack
	@if [ -z "$(VERSION)" ]; then \
		echo "Error: Could not determine version from metadata.json"; \
		exit 1; \
	fi
	@echo "Creating release v$(VERSION)..."
	@if ! command -v gh >/dev/null 2>&1; then \
		echo "Error: GitHub CLI (gh) is not installed"; \
		echo "Install with: sudo apt install gh  or  brew install gh"; \
		exit 1; \
	fi
	@if ! gh auth status >/dev/null 2>&1; then \
		echo "Error: Not authenticated with GitHub CLI"; \
		echo "Run: gh auth login"; \
		exit 1; \
	fi
	@echo "Creating git tag v$(VERSION)..."
	git tag -a "v$(VERSION)" -m "Release version $(VERSION)" || true
	git push origin "v$(VERSION)"
	@echo "Creating GitHub release..."
	gh release create "v$(VERSION)" \
		"$(PACKAGE)#Extension Package" \
		--title "v$(VERSION)" \
		--notes "Release version $(VERSION)" \
		--draft
	@echo "✓ Draft release created at: https://github.com/danst0/gnome-uptime-kuma/releases"
	@echo "  Edit the release notes and publish when ready."

# Just create and push a git tag (no release)
tag-release:
	@if [ -z "$(VERSION)" ]; then \
		echo "Error: Could not determine version from metadata.json"; \
		exit 1; \
	fi
	@echo "Creating and pushing git tag v$(VERSION)..."
	git tag -a "v$(VERSION)" -m "Release version $(VERSION)"
	git push origin "v$(VERSION)"
	@echo "✓ Tag v$(VERSION) created and pushed"
