SIMULATEUR BATTERIE GPX — BOSCH / HAIbike — WEB V2.5
==================================================

OBJECTIF
La V2 est un simulateur PRÉVISIONNEL : on charge AVANT la sortie le GPX préparé dans Komoot, puis on estime les valeurs qui devraient être observées APRÈS la sortie dans Bosch eBike Flow.

CALIBRATION V2 PAR DÉFAUT
- Batterie : 800 Wh
- Code couleur batterie : vert >20 % ; jaune 10-20 % ; rouge <10 %
- Seuil critique graphique automatique : 10 % de la capacité (80 Wh pour 800 Wh)
- Facteur distance Komoot -> Flow : x1,02775
- Rééchantillonnage spatial : 5 m
- Lissage altitude demandé : 110 m (fenêtre discrète effective ~115 m)
- Correction D+ Komoot -> Flow : x1,1356
- Tronçons : 1,0 km
- TOUR : pente positive locale < 1,29 %
- eMTB : 1,29 % à < 3,88 %
- eMTB+ : >= 3,88 %
- Consommation : TOUR 5,5 Wh/km ; eMTB 7,5 Wh/km ; eMTB+ 10,0 Wh/km
- Montée : +0,15 Wh par mètre de D+ prévu
- Recharge déjeuner par défaut : 200 Wh récupérés en ~1 h 30. Le plein est conseillé dès ~200 Wh consommés afin de revenir à 100 %.

VALIDATION PRÉVISIONNELLE DISPONIBLE
Metz (GPX Komoot -> Flow) :
- distance GPX 70,6469 km -> Flow prévu 72,607 km (Flow réel 72,558 km)
- modes prévus ~50,00 / 18,50 / 4,11 km (Flow ~49,3 / 18,6 / 4,6)
- D+ prévu ~960 m (Flow 955 m)
- énergie prévue ~598,8 Wh (référence ~600 Wh)

Roupeldange (GPX Komoot -> Flow) :
- distance GPX 70,1430 km -> Flow prévu 72,089 km (Flow détaillé ~72,522 km)
- modes prévus ~44,34 / 26,72 / 1,03 km (Flow ~43,9 / 27,0 / 1,6)
- D+ prévu ~886 m (Flow 890 m)
- énergie modèle ~587,4 Wh (référence modes Flow ~593,5 Wh)

UTILISATION
1. Ouvrir index.html dans un navigateur moderne.
2. Onglet « GPX Komoot » -> choisir le fichier .gpx exporté de Komoot.
3. Lire la prévision Flow et les deux scénarios batterie. Le graphique avec recharge affiche le solde en Wh tous les 10 km, avant/après le plein et à l’arrivée.
4. Les paramètres de calibration sont visibles dans « Paramètres V2.5 » et peuvent être réinitialisés.
5. Le même écran rappelle en lecture seule les réglages eBike Flow de référence, dans l’ordre TOUR / eMTB / eMTB+ / Turbo :
   - TOUR : 500 W ; 85 Nm ; Assistance Supérieur (+1) ; 25 km/h
   - eMTB : 425 W ; 85 Nm ; Assistance Supérieur (+3) ; 25 km/h
   - eMTB+ : 650 W ; 100 Nm ; Assistance Supérieur (+3) ; 25 km/h
   - Turbo : 600 W ; 85 Nm ; Assistance Valeur par défaut ; 25 km/h. Une modification de ces réglages dans eBike Flow ne modifie pas automatiquement le recalcul : la prévision reste fondée sur la calibration V2.5 validée.
6. « Exporter CSV » produit le détail des tronçons.

CONFIDENTIALITÉ
Le GPX est lu localement dans le navigateur. Aucun envoi Internet n'est effectué par l'application.
