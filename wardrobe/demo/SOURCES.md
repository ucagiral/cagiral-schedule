# Where the demo clothes come from

These sixteen pieces exist so the app can be opened and used before a single real
garment has been photographed. They are not Umut's clothes, they never mix with
them, and the moment a real item is added they stop being used. **Clear demo data**
in Settings removes them for good.

## Licence

Every photo comes from the [clothing dataset (subset)](https://github.com/alexeygrigorev/clothing-dataset-small)
by Alexey Grigorev, released under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) —
a public domain dedication, so no attribution is required. It is recorded here anyway,
because knowing where a file came from is worth more than the licence strictly demands.

## How the cutouts were made

The app cuts backgrounds out with a segmentation model fetched from a CDN. The
sandbox these were prepared in blocks that CDN, so the background removal here was
done with a flood fill from the photo borders, keeping only the largest connected
shape. That works on these photos because each is a single garment laid on one
broadly uniform surface; it is not a substitute for the model, and photographing
your own clothes uses the model as intended.

Everything after the background removal — the white outline, the trim to a square,
and reading the dominant colour — was produced by the app itself, driven through
its own add-item flow.

## The files

| Sticker | Name | Dataset class | Source file |
|---|---|---|---|
| `black-boots.webp` | Black boots | shoes | `train/shoes/5fea042c-f2ac-4523-a813-fc0eae2d9472.jpg` |
| `black-dress-shoes.webp` | Black dress shoes | shoes | `train/shoes/35707ebd-0264-4bbf-b5f2-a33c5c4bff4d.jpg` |
| `black-graphic-tee.webp` | Black graphic tee | t-shirt | `train/t-shirt/0b55a8e8-0087-4c19-8729-b872718ff5ae.jpg` |
| `brown-field-jacket.webp` | Brown field jacket | outwear | `train/outwear/0d047b70-c53a-463d-946f-c8758c2af391.jpg` |
| `coral-joggers.webp` | Coral joggers | pants | `train/pants/03a43dea-405e-4a11-9716-2f790a95f699.jpg` |
| `grey-sweatshirt.webp` | Grey sweatshirt | longsleeve | `train/longsleeve/0814ab03-e394-403a-9718-5ee0ee19f150.jpg` |
| `khaki-shorts.webp` | Khaki shorts | shorts | `train/shorts/1f0f0d60-7a02-46e9-b875-e206c1d8995b.jpg` |
| `navy-gilet.webp` | Navy gilet | outwear | `train/outwear/e9842306-b0f6-4053-a2fc-73c4cebe6d73.jpg` |
| `navy-shirt.webp` | Navy shirt | shirt | `train/shirt/185b7ae2-0400-40ae-8668-6ac72f737060.jpg` |
| `off-white-jeans.webp` | Off-white jeans | pants | `train/pants/0ad5bfb5-0f2b-4396-8c05-39ca0a9a2960.jpg` |
| `pale-blue-tee.webp` | Pale blue tee | t-shirt | `train/t-shirt/0e9dc3b7-f9de-4bc0-8ec1-8f442b4dcba4.jpg` |
| `plaid-cap.webp` | Plaid cap | hat | `train/hat/678edcd0-607e-433d-8433-46e11fb24df3.jpg` |
| `red-trousers.webp` | Red trousers | pants | `train/pants/0a7e5fe0-d592-40e6-b9b8-75aac9a2d685.jpg` |
| `teal-surf-tee.webp` | Teal surf tee | t-shirt | `train/t-shirt/13b58794-6daf-419a-94a7-97b7806e481e.jpg` |
| `white-print-tee.webp` | White print tee | t-shirt | `train/t-shirt/0fc3fbae-1ce6-47c3-b183-0d12bf11914f.jpg` |
| `white-shirt.webp` | White shirt | shirt | `train/shirt/0999145e-6b23-4bee-8117-dbf4aaa83f1a.jpg` |
