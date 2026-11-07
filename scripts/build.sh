#!/usr/bin/env bash
# Construit le site dans _site/ avec une copie des prix (fichier de secours de l'app).
set -euo pipefail
API="https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2"
FIELDS="id,adresse,ville,cp,geom"
for f in gazole e10 sp95 sp98 e85 gplc; do FIELDS="$FIELDS,${f}_prix,${f}_maj,${f}_rupture_debut,${f}_rupture_type"; done

rm -rf _site && mkdir -p _site/data
cp index.html app.js cost.js data.js style.css _site/
touch _site/.nojekyll
# Anti-cache : chaque publication change l'URL des fichiers JS/CSS
V="${GITHUB_SHA:-$(date +%s)}"; V="${V:0:8}"
sed -i "s/__V__/$V/g" _site/index.html _site/app.js _site/data.js

curl -fsS --retry 3 --compressed -G "$API/exports/json" \
  --data-urlencode "select=$FIELDS" -o _site/data/stations.json
COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('_site/data/stations.json')).length)")
echo "Stations exportées : $COUNT"
[ "$COUNT" -gt 5000 ] || { echo "Export suspect (moins de 5000 stations)"; exit 1; }

# Vérifie que la requête géographique utilisée par l'app fonctionne (Rennes, 5 km)
curl -fsS -G "$API/records" \
  --data-urlencode "where=within_distance(geom, geom'POINT(-1.6778 48.1173)', 5km) and gazole_prix is not null" \
  --data-urlencode "select=id,adresse,ville,geom,gazole_prix,gazole_maj" \
  --data-urlencode "limit=3" | tee /tmp/sample.json
echo
node -e "const j=JSON.parse(require('fs').readFileSync('/tmp/sample.json'));if(!j.total_count)process.exit(1);console.log('Requête géo OK :',j.total_count,'stations')"

# Vérifie les requêtes « export » utilisées par l'app (rayon et rectangle du mode trajet)
for zone in "within_distance(geom, geom'POINT(-1.6778 48.1173)', 5km)" "in_bbox(geom, 48.0, -2.0, 48.3, -1.5)"; do
  N=$(curl -fsS -G "$API/exports/json" \
    --data-urlencode "where=$zone and (gazole_prix is not null or gazole_rupture_type = \"temporaire\")" \
    --data-urlencode "select=id,geom,gazole_prix,gazole_maj,gazole_rupture_debut,gazole_rupture_type" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).length))")
  echo "Export [$zone] : $N stations"
  [ "$N" -gt 0 ] || { echo "Requête export vide"; exit 1; }
done
