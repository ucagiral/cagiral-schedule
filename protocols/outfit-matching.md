# Outfit matching — the rules the app starts from

Whether two garments go together is a matter of taste, and the app's real answer is Umut's own
swipes. But a model trained on nothing suggests a yellow t-shirt with red shorts for the first two
hundred swipes, so it starts from written rules and hands over as it learns. This file is where
those rules come from.

The handover is not total: the rules keep a floor (30%), so a run of odd swipes can't wreck every
suggestion. And each rule's score is fed to the model as a feature, which means the model can learn
that Umut dislikes something the book recommends and overrule it — the rules are a starting
position, not a constraint.

## Colour

Every garment's dominant colour is read off its cutout and converted to HSL.

**Neutrals never take a penalty, anywhere.** Black, white, grey, navy, beige, brown and denim go
with everything, which is the most reliable thing anyone says about dressing. Greys and near
black/white fall out of low saturation on their own; navy, denim and the beige-to-brown family have
to be named explicitly, because they are saturated enough to look like accents otherwise.

| Rule | What it does | Why |
|---|---|---|
| **60-30-10** | Wants about 60% of the outfit neutral, 30% a secondary colour, 10% an accent. Area shares come from the slot — bottom 35, top 30, outer 25, shoes 7, accessory 3. | A standard styling guideline, and the only colour rule that looks at the outfit as a whole rather than at pairs. Deviations are asymmetric: too much neutral is barely penalised, too much accent is fully penalised. |
| **Hue distance** | Two saturated colours within 30° (analogous) or beyond 150° (complementary) score well; 60–140° apart is penalised. | Analogous and complementary pairings are the two schemes every colour-wheel guide agrees on. The middle distances are the ones that read as a clash rather than a choice. |
| **Lightness contrast** | Wants some light/dark separation between top and bottom. | Two mid-tones sitting flat against each other is the commonest way a technically fine outfit looks wrong. |
| **One focal piece** | One accent is fine, two is penalised, three more so. | The accent in 60-30-10 is singular for a reason. |

## Beyond colour

| Rule | What it does |
|---|---|
| **Formality** | Each piece is sporty, everyday or smart. A spread greater than one step is penalised — trainers under smart trousers. |
| **Pattern** | Two patterned pieces together is heavily penalised. Of every rule here this is the one that earns its keep most often, and the one worth answering first when adding clothes. |
| **Freshness** | A small nudge towards things not worn lately, and away from yesterday's outfit. Not a matching rule — it stops a wardrobe collapsing to the same four favourites. |

Pattern is a strong penalty rather than a hard elimination. Eliminating outright would be cleaner to
describe, but a wardrobe that is mostly patterned would then have nothing to suggest, and the app
would be confidently blank instead of usefully imperfect. It is heavy enough that a two-pattern
outfit does not reach the top of a deck when any alternative exists, which the selftest checks.

## What is deliberately not modelled

- **Fit and cut.** A photograph of a garment lying flat says almost nothing about how it sits.
- **Season as a separate idea.** It is temperature, and temperature is already handled properly in
  [`clothing-insulation.md`](clothing-insulation.md).
- **Occasion beyond a tag.** The day's calendar picks lab / smart / everyday; the app does not try
  to infer more than that from what the events say.

## Sources

- [Colour Coordination: A Guide to Harmonious Outfits, Inside Out Style](https://insideoutstyleblog.com/2024/09/colour-coordination-a-guide-to-harmonious-outfits.html) — neutrals, analogous and complementary pairings, and the 60-30-10 split.
- [How to Match Clothes Using the Color Wheel, MasterClass](https://www.masterclass.com/articles/how-to-match-clothes-using-the-color-wheel) — the colour-wheel schemes, and neutrals sitting outside the wheel entirely.
- [Men's style colour theory, Westwood Hart](https://westwoodhart.com/blogs/westwood-hart/mens-style-color-theory-color-wheel-outfit-coordination) — accent pieces against a neutral base.
