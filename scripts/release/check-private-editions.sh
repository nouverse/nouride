#!/bin/sh
#
# Whether every Pro edition a tag planned reached its release — and, when none was planned, why not.
#
# Boxes update only from the Pro editions' tarballs. A tag that built none stopped every box's updates for five releases
# (0.6.x to 0.7.1) while each run stayed green, and the one sign was a warning that blamed the wrong secret: it named
# SUBMODULE_TOKEN whenever no tarball of the gateway's Pro edition was on the release, whatever the cause. The two causes are told apart:
#
#   none planned       — the plan left them out: an error naming RELEASE_VARIANTS, unless the tag message says
#                        `[public-only]`, the one way to cut a release without them on purpose;
#   planned, missing   — that edition's `binaries` job did not upload it: an error naming the job, and the token its
#                        private submodules need.
#   planned, unsigned  — its checksum file has no `.sig` beside it: an error naming the `sign` job. A `--tarball`
#                        install from this release would be checked against a file nothing vouches for, which is
#                        what every Pro release up to 0.7.9 gave it.
#
# Everything comes from the environment, so the workflow and a test feed it the same way:
#
#   PRIVATE_VARIANTS   the Pro variants the plan kept, space-separated (`pro` since 0.7.20), or empty
#   ASSETS             the names of the files on the release, space-separated
#   PUBLIC_ONLY        `yes` when the tag message says `[public-only]`
#   RELEASE_VARIANTS   the repository variable as the plan read it, for the message
#   PUBLISH_PRIVATE    `true` when this repository may carry private files at all

set -eu

if [ "${PUBLISH_PRIVATE:-}" != "true" ]; then
  echo "::notice::this repository is public, so its release carries no Pro edition"
  exit 0
fi

if [ -z "${PRIVATE_VARIANTS:-}" ]; then
  if [ "${PUBLIC_ONLY:-}" = "yes" ]; then
    echo "::notice::the tag says [public-only], so no Pro edition was built and no box is offered this release"
    exit 0
  fi
  echo "::error::this tag planned no Pro edition, so no box will be offered it. RELEASE_VARIANTS is '${RELEASE_VARIANTS:-unset}': a tag builds every edition unless that repository variable says otherwise. Unset it and re-run, or put [public-only] in the tag message to release without them on purpose."
  exit 1
fi

missing=0
for variant in ${PRIVATE_VARIANTS}; do
  # `-linux-` after the name, so `pro` is not satisfied by another edition's `nouride-pro-<something>-…`.
  case " ${ASSETS:-} " in
    *" nouride-${variant}-linux-"*) echo "nouride-${variant}: on the release" ;;
    *)
      echo "::error::nouride-${variant} was planned and is not on this release: read the binaries (${variant}) job. It builds from the private submodules, which need SUBMODULE_TOKEN; re-running the failed jobs tops the release up rather than recreating it."
      missing=1
      continue
      ;;
  esac
  case " ${ASSETS:-} " in
    *" CHECKSUMS-${variant}.sig "*) echo "CHECKSUMS-${variant}: signed" ;;
    *)
      echo "::error::CHECKSUMS-${variant} has no signature beside it on this release: read the sign job, which signs it and uploads the .sig. A --tarball install from here would be checked against a file nothing vouches for."
      missing=1
      ;;
  esac
done
exit "${missing}"
