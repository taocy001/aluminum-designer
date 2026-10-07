The project's MIT license applies to its original source code. Manufacturer CAD-derived assets here and in `../profileSections.json` retain their manufacturer attribution and source references; this project does not relicense them as original MIT assets. Rights in the referenced manufacturer material remain with the respective rights holders.

The following bracket meshes are tessellated from Motedis' public product STEP files, in physical millimetres:

| Asset | Manufacturer source | Mounting faces / transformation |
| --- | --- | --- |
| motedis-s6bbr20.json | https://www.motedis.com/shop/products_files/Motedis_S6BBR20_1.zip | Original X negated, Y preserved, Z negated |
| motedis-s8bbr30.json | https://www.motedis.com/shop/products_files/Motedis_S8BBR30.zip | Original X negated, Y preserved, Z negated |
| motedis-s8ibr40.json | https://www.motedis.com/shop/products_files/Motedis_S8IBR40_1.zip | Original X negated, Y preserved, Z negated |

Retrieved 2026-10-04. OpenCascade tessellation uses 0.1 mm linear deflection and 0.28 radian angular deflection. Positions are rounded to five decimal places. The resulting model retains actual mounting openings, cast ribs, locating tabs, and fillets. The outside mounting planes are X=0 and Y=0; the bracket body extends in +X/+Y. Locating tabs project into negative X/Y.

`collisionParts` conservatively bounds each flange, each of the four locating tabs, and each of the two side ribs separately. A 0.5 mm inward flange margin encloses cast root fillets; through holes remain filled for collision purposes. These collision pieces do not replace the display/export geometry and do not fill the bracket's open middle. Tab bounds are obtained by clipping CAD triangles into each negative-axis half and separating the two ends. The S6BBR20 tabs retain both their end taper and side taper as convex hulls of the clipped triangles. Rib depths and diagonal extents are measured from CAD triangles outside the flange regions.

The following assets were also retrieved or constructed on 2026-10-04. Each JSON carries its own source and modelling notes; physical dimensions remain in millimetres before the runtime normalisation.

| Asset | Primary source | Geometry and installation details |
| --- | --- | --- |
| motedis-s6bibm5.json | [Motedis S6BIBM5 STEP](https://www.motedis.com/shop/products_files/Motedis_S6BIBM5_1.zip) | Original casting, including the relieved horizontal shoulders and bevelled vertical shoulders. Local X = source Z − 4.2, local Y = source Y − 4.4, local Z = −source X. B6 only. |
| motedis-s8ibibm6.json | [Motedis S8IBIBM6 STEP](https://www.motedis.com/shop/products_files/Motedis_S8IBIBM6_1.zip) | Original casting shared by B8 and I8. Local X = source Z − 7, local Y = source Y − 7, local Z = −source X. Each arm's inset and screw position use its own host slot. |
| motedis-din913-m5x6.json | S6BIBM5 STEP above | Original M5×6 set screw, recentered on its axis. Thread crests are simplified in the source. |
| motedis-din913-m6x8.json | S8IBIBM6 STEP and DIN 913 dimensions | Derived closed nominal Ø6×8 body with an AF3 hex socket. Thread form, end chamfers and socket drill point are omitted. |
| 80-20-40-4332-derived.json | [80/20 40-4332](https://8020.net/40-4332.html) | Drawing-based 40×40 angle, width 36, walls 6, perpendicular bores and tool access. Fillets and the 2° droplock detail are omitted. Only the 40-series reference is verified. |
| 80-20-14173-derived.json | [80/20 14173](https://8020.net/14173.html) | Drawing-based 40 mm end-tapped corner block with three through bores and access bores. Casting pockets, fillets and removable caps are omitted. Three 4040 I8 end faces and M8 tapped end holes are required. |
| motedis-tnut-20-installed.json | [Motedis B6 nut STEP](https://www.motedis.com/shop/products_files/Motedis_S6BHASNMX_3.zip) | Original external body; template pilot hole enlarged to the M5 tapping drill diameter 4.2 mm. Thread teeth omitted. Shoulder rests at local Y = −1.5. |
| motedis-tnut-30-installed.json | [Motedis B8 M6 nut STEP](https://www.motedis.com/shop/products_files/Motedis_S8BHASNM6.zip) | Original body and factory pilot bore. Shoulder rests at local Y = −2.4, where the nut's R0.3 shoulder fillets contact the 3030 slot's R0.5 internal fillets. Thread teeth omitted. |
| motedis-tnut-40-installed.json | [Motedis I8 M8 nut STEP](https://www.motedis.com/shop/products_files/Motedis_S8ISMONM8.zip) | Original body and pilot bore; spring ball translated inward by 0.65 mm for the installed state in the 12 mm deep I8 slot. Shoulder rests at local Y = −4.5; the ball is at local Z = 9.5. Thread teeth omitted. |

The two inner castings use six convex collision pieces: two necks, two separate horizontal shoulders, and two bevelled vertical shoulders. Their empty inner quadrant and root relief remain empty. Set screws use circumscribed polygonal collision envelopes and their actual 6/8 mm lengths. Collision pieces may fill through holes conservatively; they never stand in for the displayed or exported CAD surface. Closed-shell tests independently check two oppositely directed uses of every welded mesh edge, and coverage tests require every casting vertex to lie in a collision piece.

The S6BHASNM5 collision body retains the manufacturer's 2 mm bottom chamfers: width 11.5 at Y=−2.7 narrows to 7.5 at Y=−4.7. A separate narrow neck covers Y=−1.5 through −0.5. The S8BHASNM6 body uses 16 supporting directions around the CAD section to retain the shoulder fillets and bottom chamfers; its neck is separate. Both outlines fit their corresponding B6/B8 slot floors without enlarging the slot or relaxing collision tolerance.

The derived closed solids are built offline with OpenCascade. No CAD kernel or runtime boolean operation is needed by the application. Cap and caster assets retain their own source URLs and transformation notes in their JSON records; their complete mounting limitations are recorded in `connectorAccessoryReferences.ts`.

## Accessory CAD

The following Motedis assets are in physical millimetres. Caps were retrieved on 2026-10-04 and caster 10146 on 2026-10-05. Tessellations use 0.06 mm linear deflection and 0.2 radian angular deflection, with positions rounded to five decimal places. Display and STEP export use the same closed, consistently oriented meshes.

| Assets | Manufacturer source | Local coordinates |
| --- | --- | --- |
| motedis-cap-2020.json | https://www.motedis.com/shop/products_files/Motedis_PTS6B20x20.zip | Profile centre at X=Y=0; contact plane Z=0; cover +Z, retention pins −Z |
| motedis-cap-2040.json | https://www.motedis.com/shop/products_files/Motedis_PTS6B20x40.zip | Original X/Y swapped to make the section 20 along X and 40 along Y; original Z reversed; origin at the centred contact plane |
| motedis-cap-3030.json | https://www.motedis.com/shop/products_files/Motedis_PTS8B30x30.zip | Centred contact plane; original X preserved and Y/Z reversed |
| motedis-cap-4040.json | https://www.motedis.com/shop/products_files/Motedis_PTS8I40x40.zip | Centred contact plane; original X preserved and Y/Z reversed |
| motedis-caster-10146-14.json through -21.json and -bearings.json | https://www.motedis.com/shop/products_files/Motedis_10146.zip | 22 original solids, including 14 bearing balls grouped in one asset. Source translated by (−122.1992003, −5.2027851, +178.2538749), placing the mounting top at Y=0 and swivel axis on Y; wheel axle on Z |
| din7991-m8x25-caster.json | [Motedis mounting instructions](https://www.motedis.com/shop/products_files/Motedis_Wheels.pdf), [DIN 7991 M8 head dimensions](https://belmetric.com/content/A-PDF_Drawings/SF8X40.pdf) | M8×25 countersunk screw: head Ø16×4.4, AF5 socket, 90° cone, thread flanks omitted. The cone bears on the lower rim of the caster's Ø11 mounting bore; the tip is at Y=+8.3609 |
| din7991-m6x20.json | [Motedis DIN 7991 M6×20](https://www.motedis.be/fr/Vis-a-tete-fraisee-a-six-pans-creux-selon-DIN-7991/M6x20), [M6×20 drawing](https://belmetric.com/content/1.%20Product%20Assets/SF6X20BLKSS.pdf) | Constructed from published dimensions, not manufacturer CAD. Overall length 20; head Ø12×3.3, comprising a 0.3 mm cylindrical rim and a 90° cone; AF4 socket depth 2.3. Head bottom Y=0, axis +Y. Thread flanks omitted. The B6 foot adapter seats each screw at Y=−7.9, with the tip at +12.1 |

Cap collision geometry consists of the external cover and separate inserted retention pieces. The inserted portion is intersected with a 2.5 mm XY grid and each nonempty piece is bounded independently. This preserves the open spaces between pins. At the exactly matching profile end, retention pieces allow 0.65 mm press-fit interference, including bounding-box approximation; the cover and unrelated objects do not.

The 4040 B6 cap assembly uses four unchanged `motedis-cap-2020.json` solids at XY=(±10, ±10). The right column rotates 180° around Z so the side retention tabs point outwards on both columns. Each central pin enters one B6 core. All four cover plates retain normal collision clearance; only the tagged retention pieces receive the press-fit allowance. This assembly requires four PTS6B20x20 caps per end and retains the seams between them.

Caster 10146 retains the fork, wheel, bearings, axle, axle nut and swivel assembly. The axle nut's internal thread is replaced by a smooth Ø8.02 bore; its external surfaces are retained. Fork collision boxes bound triangles clipped into 5 mm Y slabs and three Z bands divided at ±15 mm, preserving the open space between the arms. Its source STEP and drawing specify a 75 mm wheel, 25 mm width, 99.7 mm mounting height, 29.94 mm offset and Ø11 mounting bore; the product webpage instead lists Ø10. The assets follow the STEP and drawing. Motedis' mounting instructions specify one DIN 7991 M8×25 screw into the tapped central bore of 3030 B8 or 4040 I8. The model includes this screw and 8.36 mm thread engagement; it does not use a slot nut or adapter plate. Accessory product links, dimensional references and installation restrictions are documented in [CONNECTOR-ACCESSORIES.md](../../../docs/CONNECTOR-ACCESSORIES.md).

## 4040 B6 profile section

The `4040-B6` entry in `../profileSections.json` comes from [Motedis 40×40 B-type slot 6](https://www.motedis.com/en/Profile-40x40-B-type-slot-6) and its [original STEP](https://www.motedis.com/shop/products_files/Motedis_profile%2040x40%20B-Type%20slot%206.zip), retrieved 2026-10-05. Its centred section retains the eight B6 slots, four cores at XY=(±10, ±10), and the central void. Curved edges use a maximum 0.05 mm chord error. This section is distinct from the `4040` I8 profile: it has no central core for direct M8 foot or caster installation.
