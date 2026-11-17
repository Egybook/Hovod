# GitHub Actions maintenance — Node.js 24 compatibility

This maintenance updates workflow action versions to releases whose action runtimes are compatible with Node.js 24. It does **not** change the Hovod application runtime: `actions/setup-node` continues to install Node.js 22.23.4 for the project.

## Updated workflow references

- `actions/checkout`: v4 → v7
- `actions/setup-node`: v4 → v7
- `actions/upload-artifact`: v4 → v7
- `actions/download-artifact`: v4 → v8
- `docker/setup-buildx-action`: v3 → v4
- `docker/build-push-action`: v6 → v7
- `docker/login-action`: v3 → v4
- `docker/metadata-action`: v5 → v6

All workflow files under `.github/workflows/` were checked for these references.

## Ongoing maintenance

Added `.github/dependabot.yml` to propose weekly GitHub Actions and npm dependency updates. Updates arrive as pull requests and are **not** applied automatically to the production branch. Review release notes and CI results before merging.

## Safety boundaries

- No application source, Dockerfile, playback security, database schema, storage configuration, or deployment secrets were changed.
- The application CI runtime remains Node.js 22.23.4. Only the JavaScript runtime used internally by GitHub Actions is upgraded.
- This change does not publish a Docker image by itself.

## Validation status

Static reference scan and YAML syntax validation are required locally. GitHub-hosted execution is still required to confirm compatibility of the upgraded actions and to verify that the Node.js 20 deprecation warnings are gone.
