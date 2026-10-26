# Décodeur — application iPhone autonome

Tu choisis une ou plusieurs captures de ton graphique MT5. **L'appli fait toute l'analyse elle-même, sur ton iPhone, sans internet, sans IA et sans abonnement :**

1. Elle lit le texte de la capture (prix de l'axe, paire, unité de temps) avec la reconnaissance de texte intégrée à iOS.
2. Elle repère chaque bougie d'après ses couleurs et en déduit ouverture, plus haut, plus bas et clôture.
3. Elle calcule les indicateurs (EMA20, EMA50, RSI 14, MACD, ATR 14), la structure des sommets et des creux, les supports et résistances, les figures (canaux, triangles, biseaux, double sommet ou creux, cassures) et les chandeliers (avalements, marteau, étoile filante, doji, étoiles du matin et du soir, mèches de rejet).
4. Elle additionne ces signaux en un score, propose des scénarios chiffrés (déclencheur, entrée, stop, deux objectifs) adaptés à ta façon de trader, et calcule la taille de position et la marge selon ton capital.
5. Elle écrit chaque point deux fois : la version technique, et sa traduction **en clair**.

Après chaque analyse, la section **Contrôle de lecture** dessine sur ta capture les bougies repérées (points orange) et les niveaux retenus (lignes). Si le dessin ne colle pas au graphique, la lecture est fausse : refais la capture en suivant l'onglet **Bien capturer**.

Tout reste sur ton iPhone : réglages et historique sont dans les fichiers privés de l'appli.

---

## Ce qui est gratuit

Tout : l'appli, l'analyse, la compilation et l'installation. La seule contrainte vient d'Apple : avec un identifiant Apple gratuit, **l'appli doit être réinstallée tous les 7 jours** (deux minutes, ton historique est conservé si tu ne supprimes pas l'appli).

---

## Installer l'appli : choisis ta route

### Route A — Tu as un Mac

1. Installe **Xcode** depuis l'App Store du Mac.
2. Installe XcodeGen : dans le Terminal, `brew install xcodegen` (Homebrew : https://brew.sh).
3. Dans le Terminal, place-toi dans ce dossier et lance `xcodegen generate`. Ouvre le fichier `Decodeur.xcodeproj` créé.
4. Dans Xcode : projet **Decodeur** → onglet **Signing & Capabilities** → **Team** : ajoute ton identifiant Apple et choisis ton « Personal Team ».
   Si Xcode dit que l'identifiant `com.decodeurgraphique.autonome` est déjà pris, remplace la fin par quelque chose d'unique.
5. Branche ton iPhone, sélectionne-le en haut de la fenêtre, clique sur ▶︎.
6. Sur l'iPhone, fais les réglages du « Premier lancement » ci-dessous.

**Tous les 7 jours** : rebranche l'iPhone et clique à nouveau sur ▶︎.

### Route B — Tu n'as qu'un PC Windows

**B1. Faire compiler l'appli par GitHub (gratuit)**

1. Crée un compte sur https://github.com et un nouveau dépôt **Public** (gratuit pour les compilations ; le code ne contient aucune donnée personnelle).
2. **Add file → Upload files** : glisse `project.yml`, `README.md` et le dossier `Decodeur`, puis **Commit changes**.
3. Le dossier caché `.github` passe mal par le glisser-déposer : **Add file → Create new file**, nomme le fichier exactement `.github/workflows/build-ipa.yml`, colle le contenu du fichier du même nom fourni ici, puis **Commit changes**.
4. Onglet **Actions** → **Construire l'IPA** → **Run workflow**. Attends 5 à 10 minutes la pastille verte.
5. Ouvre l'exécution, télécharge **Decodeur-ipa** en bas de page et décompresse-le : tu obtiens `Decodeur.ipa`.

Si la pastille est rouge, ouvre l'étape en erreur et envoie le message à Claude pour qu'il corrige le code.

**B2. Installer sur l'iPhone avec Sideloadly**

1. Sur le PC, installe **iTunes** et **iCloud** depuis le site d'Apple (pas les versions du Microsoft Store).
2. Installe **Sideloadly** (gratuit) depuis son site officiel.
3. Branche l'iPhone et accepte « Faire confiance à cet ordinateur ».
4. Dans Sideloadly : choisis l'iPhone, entre ton identifiant Apple, glisse `Decodeur.ipa`, clique sur **Start**.
5. Fais les réglages du « Premier lancement ».

**Tous les 7 jours** : refais l'étape 4 avec le même fichier, sans supprimer l'appli.

### Premier lancement

1. Réglages → Confidentialité et sécurité → **Mode développeur** → activer, redémarrer et confirmer.
2. Réglages → Général → **VPN et gestion de l'appareil** → ton identifiant Apple → **Faire confiance**.
3. Ouvre **Décodeur**. Dans **Mon compte**, indique ton capital, ta devise et ton risque par trade.

---

## Bien capturer dans MT5

- Bougies **vertes** (hausse) et **rouges** (baisse), fond uni blanc ou noir.
- **Aucun indicateur** sur le graphique : l'appli calcule elle-même EMA, RSI, MACD et ATR. Une moyenne mobile de la couleur des bougies en fait disparaître.
- L'**axe des prix** bien visible à droite, avec au moins trois valeurs.
- **40 à 120 bougies** à l'écran : trop dézoomé, les bougies deviennent des traits.
- La paire et l'unité de temps visibles en haut à gauche, sinon choisis-les dans l'appli.
- Deux captures donnent plus de recul : une grande unité (H1) pour le contexte, une petite (M5) pour l'entrée.

---

## Les limites, honnêtement

- C'est une **analyse par règles**, comme un indicateur évolué : rapide, régulière et vérifiable, mais elle ne « comprend » pas le marché comme un analyste. Le pourcentage affiché est un **score de signaux**, pas une probabilité garantie ; le détail du calcul est dans « Calcul du score ».
- La lecture des bougies a été mise au point sur des captures simulées au format MT5 (fond clair et sombre, bougies pleines ou creuses, lignes de prix, volumes, moyennes mobiles). Les réglages d'affichage de ton MT5 peuvent demander un ajustement : vérifie toujours le **Contrôle de lecture** lors des premiers essais.
- Ce n'est pas un conseil en investissement : vérifie les niveaux sur ton propre graphique avant d'agir.

---

## Structure du projet

```
project.yml                      Description du projet pour XcodeGen
.github/workflows/build-ipa.yml  Compilation gratuite sur GitHub
Decodeur/
  App/DecodeurApp.swift          Coque iPhone : affichage, lecture du texte par iOS, enregistrement local
  web/index.html, style.css      Interface
  web/reader.js                  Lecture de la capture : axe des prix, bougies, nettoyage des lignes et volumes
  web/engine.js                  Moteur d'analyse et rédaction technique + en clair
  web/app.js                     Fonctionnement de l'interface, taille de position, historique
  Assets.xcassets/               Icône et couleur d'accent
```
