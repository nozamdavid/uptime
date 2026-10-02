.PHONY: images-push

IMAGE_NAMESPACE ?= dmarcosm
IMAGE_TAG ?= latest
PLATFORM ?= linux/amd64

# Build every deployable image and publish it to the configured registry namespace.
images-push:
	IMAGE_NAMESPACE="$(IMAGE_NAMESPACE)" IMAGE_TAG="$(IMAGE_TAG)" PLATFORM="$(PLATFORM)" \
		./scripts/build-and-push-images.sh
