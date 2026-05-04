# Besoins — plugin CursorPets

Document de référence pour les **exigences fonctionnelles**, **intégrations**, **contraintes** et **pistes de mise à jour** du plugin. Le détail d’implémentation et l’historique restent dans le code et le `README.md`.

---

## 1. Objectif produit

- Offrir un **compagnon léger** dans Cursor, dans l’esprit GitPets : présent, peu intrusif, réactif au contexte de dev.
- **Ne pas** se positionner comme widget de productivité obligatoire : animations, humeur et messages doivent rester optionnels et configurables.

---

## 2. Besoins fonctionnels (cœur)

| ID | Besoin | Statut (indicatif) |
|----|--------|-------------------|
| F1 | Afficher un pet dans une **Webview View** (barre d’activité) | Couvert |
| F2 | **Choisir un pet** (liste, persistance réglages) | Couvert |
| F3 | **États / humeurs** (idle, focused, happy, waiting, concerned) liés au contexte | Couvert |
| F4 | Réactions aux **événements éditeur** : sauvegarde, changement d’éditeur actif, diagnostics, inactivité | Couvert |
| F5 | **Réglages** : activer/désactiver, intensité d’animation, pet sélectionné, manifeste optionnel | Couvert |
| F6 | **Commandes** palette : afficher/masquer, reset, import, notifications, flottant, etc. | Couvert |
| F7 | **Panneau** : pause, reset, float, import, source, notifications ; **chat IA** : palette (`cursorPets.openChat`) + bouton **fenêtre flottante** macOS (fichier signal + activation Cursor via **AppleScript** avant commandes workbench) | Couvert |
| F8 | **Import** manifeste local + URL GitPets (+ import presse-papiers si besoin) | Couvert |
| F9 | **Annonces** (diagnostics, tâches, debug, actions extension) + historique + effet visuel flottant (notify) | Couvert |
| F10 | **Fenêtre flottante** macOS (hors iframe webview) + opacités / cadre configurable | Couvert (macOS) |
| F11 | Option **LaunchAgent** macOS pour lancer le float au login | Couvert |
| F12 | **Transcripts Agent** Cursor (fichiers `.jsonl` sous `~/.cursor/projects/...`) : bulle best-effort | Couvert |
| F13 | **Terminal** : annonce de sortie shell si intégration shell disponible (désactivé par défaut) | Couvert |
| F14 | **Tâches / build** : annonce selon le **code de sortie** du processus quand l’API `onDidEndTaskProcess` s’applique (`cursorPets.tasks.reactToProcessExit`) | Couvert |

---

## 3. Besoins d’intégration GitPets & contenu

- **Découverte / catalogue** : aujourd’hui manifeste local + import URL ; besoin long terme d’une **source stable ou officielle** (API, format, licence).
- **Redistribution** : ne pas embarquer d’assets tiers sans droits clairs ; **attribution** auteur/source conservée dans l’UI.
- **Remplacement des placeholders** : besoin de **pets autorisés** ou flux catalogue validé (cf. README, milestone actuel).
- **Schéma manifeste** : versionner et documenter les évolutions (`schemas/pet-manifest.schema.json`).

---

## 4. Besoins plateforme & compatibilité

- **Cursor / VS Code** : extension API `^1.92.0` ; comportements **spécifiques Cursor** (transcripts, commandes chat) peuvent changer entre versions → **tests manuels** après upgrade Cursor.
- **Flottant** : dépend d’un **helper Swift macOS** ; ouverture chat depuis le float = **fichier signal** surveillé par l’extension + **`osascript`** pour remettre Cursor au premier plan (permission **Automatisation** possible) ; besoin futur explicite si extension **Windows / Linux** : autre stratégie (webview only, etc.).
- **Notifications natives Cursor** : pas d’API globale d’écoute ; le plugin ne peut annoncer que ce qui passe par les **APIs exposées**.

---

## 5. Besoins non fonctionnels

- **Performance** : lectures transcript en queue / tail, limites `tailBytes` / `maxChars` — éviter de bloquer l’host extension.
- **Confidentialité** : transcripts et terminal peuvent contenir du code ou des secrets → réglages par défaut prudents, docs utilisateur claires.
- **Robustesse** : commandes `executeCommand` pour le chat : **liste de repli** + message si aucune commande ne réussit.
- **Licence & distribution** : licence dépôt à trancher ; publication **Open VSX / Marketplace** si objectif de diffusion.

---

## 6. Pistes de mise à jour (backlog / idées)

Aligné sur la vision du `README.md` et l’état actuel du code :

1. **Catalogue GitPets** synchronisé dès qu’une source officielle ou stable existe.
2. **Personnalités / plusieurs pets** en parallèle ou rotation.
3. **Animations déblocables** (streaks, objectifs).
4. **Réactions tests / build** — *en cours* : codes de sortie processus (`onDidEndTaskProcess`) ; poursuivre avec groupes de tâches *test*, watchers, etc.
5. **« Mémoire » workspace** (messages ou état léger par dossier).
6. **MCP ou hooks** pour que l’Agent Cursor dialogue avec le pet de façon structurée.
7. **Empaquetage « plugin Cursor »** si le produit se stabilise et que le canal le permet.
8. **Parité flottant** hors macOS si la demande utilisateur est là.
9. **README / BESOINS** : liste des commandes et liens tenus à jour (chat : palette + float : signal + activation + workbench ; LaunchAgent à 4 arguments).

---

## 7. Critères de « done » pour une release

- `npm run compile` sans erreur.
- Smoke test dans **Cursor** : panneau, float (si macOS), import manifeste, annonce test, ouverture chat depuis la palette et depuis le bouton float (vérifier message barre d’état + focus Agent ; **Automatisation** macOS si demandée).
- Schéma JSON et `package.json` (commands, `activationEvents`, settings) **cohérents** avec le code.

---

## 8. Maintenance de ce fichier

À mettre à jour lorsque :

- un **nouveau besoin majeur** est validé ou abandonné ;
- une **intégration externe** (GitPets, Cursor) change de contraintes ;
- la **roadmap** priorise une nouvelle surface (MCP, multi-plateforme, marketplace).
