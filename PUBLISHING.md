# Publishing @martindye/dsh-model-dial

The npm account uses a **stage-only** granular token: a plain `npm publish`
is rejected by design, so every version goes through npm's staged-publish
gate (same flow as `@martindye/dsh-voice`).

## Flow
1. Make the changes, rebuild (`pnpm bundle`).
2. Bump `version` in package.json and commit.
3. From the repo root: `npm stage publish` (token lives in `~/.npmrc`;
   this step needs no 2FA).
4. Martin approves the version in the **Staged Packages** tab on
   npmjs.com — that step needs his 2FA. The version goes live on the
   registry the moment it is approved.

## Pack contents
The `files` whitelist in package.json (src, lib, cordis.patch.yml,
README.md, LICENSE). `lib/` is included on purpose — the published
package ships prebuilt, so `dsh plugin add` needs no build step.

## Version history
- 1.0.0 (24/10): first public version (renamed from @martin/dsh-model-dial)
  — the prefill gauge, the generating label, and the compaction indicator
  with the live summary percentage, all in one 34 px ring.
