# Clothing insulation — what the standards say

The wardrobe app has to answer one question every morning: is this enough for today? That means a
number for how much each garment insulates, and a number for how much insulation the day needs.
Both are taken from published thermal-comfort work rather than invented, because a made-up scale
would look identical on screen and be wrong in a way nobody could check.

For how the app *uses* these — the tolerances, the per-item rules, the personal calibration —
see [`../README.md`](../README.md#wardrobe). This file is the outside reference.

## The unit

**clo** is the standard unit of clothing insulation. 1 clo is the insulation that keeps a person
comfortable sitting still at 21 °C in still air — about what a business suit provides. It is
defined in ASHRAE Standard 55 and ISO 9920 and is not app-specific.

## Garment values

Per-garment values from the ISO 9920 / ASHRAE 55 tables. Where sources give a spread it is
recorded, because the spread is exactly what the app's 1–5 thickness step is choosing within.

| Garment | clo | Notes |
|---|---|---|
| Sleeveless undershirt | 0.06 | Bottom of the base-layer range. |
| T-shirt, short sleeves | **0.10** | The most-quoted single value. |
| Shirt, short sleeves | 0.15–0.25 | |
| Shirt, long sleeves | 0.20–0.30 | |
| Sweater, long sleeves | 0.20–0.40 | The widest spread of any common garment — a thin knit and a heavy one are genuinely twice apart. |
| Trousers | 0.25–0.35 | |
| Long skirt / robe | 0.22–0.77 | Not used by the app, recorded for completeness. |
| Shoes | 0.02–0.10 | Small, which is the whole reason the app needs a rule beyond the arithmetic — see below. |
| Jacket to heavy parka | 0.20–1.50 | The single biggest lever on a cold day. |

**Ensembles add up.** ISO 9920 defines a summation method: the insulation of an outfit is the sum
of its garments' values. That is what the app does, and it is why layering a shirt under a sweater
is modelled rather than special-cased.

## How much is needed

Above freezing, the rule of thumb is roughly **0.16 clo per °C** — a difference of about 0.16 clo
keeps you as warm for each 1 °C lost. Anchored at the definition of clo itself (1 clo, 21 °C, at
rest):

```
required_clo = (1.0 + (21 − T) × 0.16) × activity − personal_offset
```

- **T** is apparent temperature, not air temperature. Open-Meteo's `apparent_temperature` already
  folds in wind and humidity, so there is no separate wind-chill term anywhere in the app.
- **activity** scales the whole thing down, because the 1 clo / 21 °C reference assumes sitting
  still indoors and the app is dressing someone who will be outdoors and on their feet. The default
  is 0.6.
- **personal_offset** is learned from cold / just right / too warm answers after actually wearing an
  outfit.

The activity factor is the weakest number here, and it is deliberately the one the calibration
absorbs. ISO 11079 defines a proper index for this (IREQ) that accounts for metabolic rate, wind
and clothing area factor; the app uses the simple form plus a personal correction instead, because
a fitted offset from Umut's own answers beats a better formula fed a guessed metabolic rate.

## Where the arithmetic is not enough

Shoes are 0.02–0.10 clo — under 5% of a winter outfit. So the sum genuinely cannot tell winter
boots from summer trainers, and left to itself it will put boots on a 32 °C day and be arithmetically
correct doing it. The app adds a per-item rule for this: once the day needs less than 0.5 clo
(around 22 °C and up), the thickest items in every category are dropped regardless of what the total
allows. It is a rule about garments, not about heat, which is why it cannot come out of the physics.

## Sources

- [Clo — Clothing and Thermal Insulation, Engineering ToolBox](https://www.engineeringtoolbox.com/clo-clothing-thermal-insulation-d_732.html) — the definition, and the 1 clo / 21 °C anchor.
- [Insulation: First the Body, Then the Home, Low-Tech Magazine](https://solar.lowtechmagazine.com/2011/02/insulation-first-the-body-then-the-home/) — per-garment clo values and the ~0.16 clo per °C rule of thumb.
- [Validation of the ISO 9920 clothing item insulation summation method (PMC7855677)](https://pmc.ncbi.nlm.nih.gov/articles/PMC7855677/) — that summing garment values is a sound way to get an ensemble's insulation.
- [ANSI/ASHRAE Standard 55 Addendum h](https://www.ashrae.org/File%20Library/Technical%20Resources/Standards%20and%20Guidelines/Standards%20Addenda/55_2010_h_Final.pdf) — the standard's clothing insulation tables.
- [pythermalcomfort — Clothing](https://pythermalcomfort.readthedocs.io/en/latest/documentation/clothing.html) — the same tables in a form that can be checked against code.
- [ISO 11079 / IREQ, required clothing insulation](https://lipidity.com/clo/required/) — the fuller model the simple form above stands in for.
