#!/usr/bin/env bash

# Keep the prelaunch branch on isolated staging resources.
select_deployment_environment() {
  local repo_root="$1" requested="${2:-}" branch
  if ! branch="$(git -C "$repo_root" symbolic-ref --quiet --short HEAD)"; then
    printf 'deployment-target: a named branch is required for deployment\n' >&2
    return 1
  fi
  deployment_environment="$requested"
  if [[ -z "$deployment_environment" ]]; then
    deployment_environment="production"
    [[ "$branch" != "codex/product-release-plan" ]] || deployment_environment="staging"
  fi
  case "$deployment_environment" in
    staging|production) ;;
    *) printf 'deployment-target: environment must be staging or production\n' >&2; return 1 ;;
  esac
  if [[ "$branch" == "codex/product-release-plan" && "$deployment_environment" == "production" ]]; then
    printf 'deployment-target: codex/product-release-plan can only deploy to staging\n' >&2
    return 1
  fi
}
