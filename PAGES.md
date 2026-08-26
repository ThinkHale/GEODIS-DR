# GitHub Pages

The site is served straight from `main` at the repo root, with the custom domain
in `CNAME`.

## Why `.nojekyll` exists

Pages runs Jekyll by default (`build_type: legacy`). Nothing here is a Jekyll
site — it is plain HTML, CSS and JS — but Jekyll still walks every tracked file,
and the repo carries 84 files under `.agents/`, at least one containing Liquid
syntax (`{{ … }}`). On 2026-08-26 that took the build from "built" to
"Page build failed" with no further detail, and the live site silently stayed on
the previous commit for over an hour while pushes appeared to succeed.

`.nojekyll` disables the Jekyll pipeline entirely. Files are published exactly as
committed, builds are faster, and Liquid can never mangle a `{{` inside a
JavaScript template literal.

**Do not delete it.**

## Checking a deploy

A push is not a deploy. To see whether the site actually rebuilt:

```sh
gh api repos/ThinkHale/GEODIS-DR/pages/builds \
  --jq '.[:3][] | "\(.created_at)  \(.status)  \(.commit[0:7])  \(.error.message // "")"'
```

`status` of `built` means live; `errored` means the site is still serving the
last good commit no matter what `git push` reported.
