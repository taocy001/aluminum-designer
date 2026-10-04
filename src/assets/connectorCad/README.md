The project's MIT license applies to its original source code. Manufacturer CAD-derived assets here and in `../profileSections.json` retain their manufacturer attribution and source references; this project does not relicense them as original MIT assets. Rights in the referenced manufacturer material remain with the respective rights holders.

The following bracket meshes are tessellated from Motedis' public product STEP files, in physical millimetres:

| Asset | Manufacturer source | Mounting faces / transformation |
| --- | --- | --- |
| motedis-s6bbr20.json | https://www.motedis.com/shop/products_files/Motedis_S6BBR20_1.zip | Original X negated, Y preserved, Z negated |
| motedis-s8bbr30.json | https://www.motedis.com/shop/products_files/Motedis_S8BBR30.zip | Original X negated, Y preserved, Z negated |
| motedis-s8ibr40.json | https://www.motedis.com/shop/products_files/Motedis_S8IBR40_1.zip | Original X negated, Y preserved, Z negated |

Retrieved 2026-10-04. OpenCascade tessellation uses 0.1 mm linear deflection and 0.28 radian angular deflection. Positions are rounded to five decimal places. The resulting model retains actual mounting openings, cast ribs, locating tabs, and fillets. The outside mounting planes are X=0 and Y=0; the bracket body extends in +X/+Y. Locating tabs project into negative X/Y.

`collisionParts` conservatively bounds each flange, each of the four locating tabs, and each of the two side ribs separately. A 0.5 mm inward flange margin encloses cast root fillets; through holes remain filled for collision purposes. These collision pieces do not replace the display/export geometry and do not fill the bracket's open middle. Tab bounds are obtained by clipping CAD triangles into each negative-axis half and separating the two ends, then bounding each clipped part. Rib depths and diagonal extents are measured from CAD triangles outside the flange regions.

The following assets were also retrieved or constructed on 2026-10-04. Each JSON carries its own source and modelling notes; physical dimensions remain in millimetres before the runtime normalisation.

| Asset | Primary source | Geometry and installation details |
| --- | --- | --- |
| motedis-s6bibm5.json | [Motedis S6BIBM5 STEP](https://www.motedis.com/shop/products_files/Motedis_S6BIBM5_1.zip) | Original casting, including the relieved horizontal shoulders and bevelled vertical shoulders. Local X = source Z − 4.2, local Y = source Y − 4.4, local Z = −source X. B6 only. |
| motedis-s8ibibm6.json | [Motedis S8IBIBM6 STEP](https://www.motedis.com/shop/products_files/Motedis_S8IBIBM6_1.zip) | Original casting shared by B8 and I8. Local X = source Z − 7, local Y = source Y − 7, local Z = −source X. Each arm's inset and screw position use its own host slot. |
| motedis-din913-m5x6.json | S6BIBM5 STEP above | Original M5×6 set screw, recentered on its axis. Thread crests are simplified in the source. |
| motedis-din913-m6x8.json | S8IBIBM6 STEP and DIN 913 dimensions | Derived closed nominal Ø6×8 body with an AF3 hex socket. Thread form, end chamfers and socket drill point are omitted. |
| 80-20-40-4332-derived.json | [80/20 40-4332](https://8020.net/40-4332.html) | Drawing-based 40×40 angle, width 36, walls 6, perpendicular bores and tool access. Fillets and the 2° droplock detail are omitted. Only the 40-series reference is verified. |
| 80-20-14173-derived.json | [80/20 14173](https://8020.net/14173.html) | Drawing-based 40 mm end-tapped corner block with three through bores and access bores. Casting pockets, fillets and removable caps are omitted. Three 4040 end faces and M8 tapped end holes are required. |
| motedis-tnut-20-installed.json | [Motedis B6 nut STEP](https://www.motedis.com/shop/products_files/Motedis_S6BHASNMX_3.zip) | Original external body; template pilot hole enlarged to the M5 tapping drill diameter 4.2 mm. Thread teeth omitted. Shoulder rests at local Y = −1.5. |
| motedis-tnut-30-installed.json | [Motedis B8 M6 nut STEP](https://www.motedis.com/shop/products_files/Motedis_S8BHASNM6.zip) | Original body and factory pilot bore. Shoulder rests at local Y = −2.2. Thread teeth omitted. |
| motedis-tnut-40-installed.json | [Motedis I8 M8 nut STEP](https://www.motedis.com/shop/products_files/Motedis_S8ISMONM8.zip) | Original body and pilot bore; spring ball translated inward by 0.65 mm for the installed state in the 12 mm deep I8 slot. Shoulder rests at local Y = −4.5; the ball is at local Z = 9.5. Thread teeth omitted. |

The two inner castings use six convex collision pieces: two necks, two separate horizontal shoulders, and two bevelled vertical shoulders. Their empty inner quadrant and root relief remain empty. Set screws use circumscribed polygonal collision envelopes and their actual 6/8 mm lengths. Collision pieces may fill through holes conservatively; they never stand in for the displayed or exported CAD surface. Closed-shell tests independently check two oppositely directed uses of every welded mesh edge, and coverage tests require every casting vertex to lie in a collision piece.

The derived closed solids are built offline with OpenCascade. No CAD kernel or runtime boolean operation is needed by the application. Cap and caster assets retain their own source URLs and transformation notes in their JSON records; their complete mounting limitations are recorded in `connectorAccessoryReferences.ts`.

## Accessory CAD

The following Motedis assets are in physical millimetres and were retrieved on 2026-10-04. The cap and caster tessellations use 0.06 mm linear deflection and 0.2 radian angular deflection, with positions rounded to five decimal places. Display and STEP export use the same closed, consistently oriented meshes.

| Assets | Manufacturer source | Local coordinates |
| --- | --- | --- |
| motedis-cap-2020.json | https://www.motedis.com/shop/products_files/Motedis_PTS6B20x20.zip | Profile centre at X=Y=0; contact plane Z=0; cover +Z, retention pins −Z |
| motedis-cap-2040.json | https://www.motedis.com/shop/products_files/Motedis_PTS6B20x40.zip | Original X/Y swapped to make the section 20 along X and 40 along Y; original Z reversed; origin at the centred contact plane |
| motedis-cap-3030.json | https://www.motedis.com/shop/products_files/Motedis_PTS8B30x30.zip | Centred contact plane; original X preserved and Y/Z reversed |
| motedis-cap-4040.json | https://www.motedis.com/shop/products_files/Motedis_PTS8I40x40.zip | Centred contact plane; original X preserved and Y/Z reversed |
| motedis-caster-963-0.json through -7.json | https://www.motedis.com/shop/products_files/Motedis_963.zip | Eight original solids; original Y translated by −56.7 so the mounting top is Y=0; X/Z unchanged |

Cap collision geometry consists of the external cover and separate inserted retention pieces. The inserted portion is intersected with a 2.5 mm XY grid and each nonempty piece is bounded independently. This preserves the open spaces between pins. At the exactly matching profile end, retention pieces allow 0.65 mm press-fit interference, including bounding-box approximation; the cover and unrelated objects do not.

Caster 963 retains the fork, wheel, rims, axle, nut, washer and swivel housing. The source STEP and drawing specify an 11 mm mounting bore and 74.2 mm height; its product webpage instead lists 6.5 mm and 71 mm. The assets follow the STEP, and the application does not supply an unverified mounting adapter or fastening recipe. Accessory product links, dimensional references and installation restrictions are documented in [CONNECTOR-ACCESSORIES.md](../../../docs/CONNECTOR-ACCESSORIES.md).
