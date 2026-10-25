#!/bin/sh
# fanwiki-kill-switch.sh — take fan wikis out of the code. Run from anywhere in a clone of the repo, then commit,
# push and deploy as usual (./deploy.sh on the server).
#
#   --non-open  deletes api/fanwikis-nonopen.php: every wiki that isn't openly licensed (CC BY-NC, unclear or closed)
#               and the copying of fair-use pictures. Openly licensed wikis keep working.
#   --all       deletes the whole fan wiki module: api/fanwikis*.php, static/fanwikis.js, its tests and its script tag.
#               The rest of the app checks for the module and carries on without it.
#
# Without touching the code, the config does the same at once: 'fan_wikis' => ['open_only' => true] for --non-open,
# 'fan_wikis' => ['enabled' => false] for --all.
#
# Pictures already copied to entries stay there either way. The ones that aren't openly licensed are listed by:
#   SELECT id, campaign_id, parent_id, original_name, credit_license, credit_source FROM attachments
#     WHERE credit_license = 'Personal fair use, not openly licensed' OR credit_license LIKE '%, personal use';
set -e
cd "$(git rev-parse --show-toplevel)"

case "$1" in
  --non-open)
    git rm -q api/fanwikis-nonopen.php
    echo "Removed api/fanwikis-nonopen.php: only openly licensed fan wikis and pictures are left." ;;
  --all)
    git rm -q --ignore-unmatch api/fanwikis.php api/fanwikis-open.php api/fanwikis-nonopen.php static/fanwikis.js \
      tests/browser/fan-wikis.spec.js tests/support/fanwiki-stub.php
    sed -i.bak '/static\/fanwikis\.js/d' index.html && rm -f index.html.bak
    git add index.html
    echo "Removed the fan wiki module." ;;
  *)
    echo "Usage: $0 --non-open | --all" >&2
    exit 2 ;;
esac

find api -name '*.php' -exec php -l {} \; > /dev/null
echo "PHP syntax checked. Next: update the About notes in SOURCES-TO-LICENSE.md, then git commit and push."
echo "Copied pictures that aren't openly licensed stay on their entries; this script's header has the SQL that lists them."
