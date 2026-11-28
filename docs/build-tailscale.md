# Building tailscale for the box

Tailscale publishes no macOS build of `tailscaled` that starts before anyone signs in. `.github/workflows/build-tailscale.yml` builds `tailscale` and `tailscaled` twice, on macOS and on Linux, and fails unless the two builds are byte-identical. It pins Tailscale, Go and the actions it uses. Its tarball carries Tailscale's and Go's licences.

Run it by hand from `main`, with no inputs. It makes a draft release named `tailscale-<version>-run<run ID>`. Publish the draft, then pin its asset ID and the SHA-256s in `versions.json` in a reviewed PR.

The install checks the download against that pin. The open source `tailscaled` does not update itself: rebuild and install a fix within 7 days of a Tailscale security bulletin.
