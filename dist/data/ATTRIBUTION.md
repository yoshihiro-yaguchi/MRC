# Geographic data attribution

The clone application is independently implemented. These files contain factual
geographic data, extracted and converted from the publicly distributed data
container of [Railway Canvas](https://games.raconasu.com/railway-canvas), retrieved
2026-11-13. No original application source is included in this directory.

## Railway lines and stations

- Original geographic source: Ministry of Land, Infrastructure, Transport and
  Tourism, Japan, **National Land Numerical Information, Railway Data N02-25**.
- [Dataset](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html)
- [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Transformation by this project: decode the distribution geometry format into
  WGS84 GeoJSON LineStrings/Points, round geographic line coordinates to six
  decimal places, and add bounding boxes for map rendering. Station names and
  coordinate facts are from the distribution's `TimetableTrip/RailwayData/runtime_shards`
  station metadata. Original timetables and application code are not included.
- Converted file: `railways.json`.

## Land prices

- Original source: MLIT Japan National Land Numerical Information **L01 2026**,
  standard land appraisal, yen per square metre. Appraised values are not actual
  transaction prices.
- [Source archive](https://nlftp.mlit.go.jp/ksj/gml/data/L01/L01-26/L01-26_GML.zip)
- [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Transformation: extraction from the public distribution container; factual
  coordinate and price values unchanged. Metadata explanation added.
- Converted file: `land-prices.json`.

## Population

- Original source: **WorldPop, JPN 2020 population, 1km aggregated**.
- DOI: [10.5258/SOTON/WP00670](https://doi.org/10.5258/SOTON/WP00670)
- [Source directory](https://data.worldpop.org/GIS/Population/Global_2000_2020_1km/2020/JPN/)
- [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Population values are estimates, not observed OD or station ridership.
- Transformation: extraction of the pre-aggregated factual dataset from the
  public distribution container; values unchanged, gzip compression retained.
- File: `population.json.gz`.

## Town names

- Original source: [Geolonia Japanese Addresses](https://github.com/geolonia/japanese-addresses),
  derived from public MLIT address data.
- [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Transformation: extraction of point/name facts from the public distribution
  container; values unchanged, gzip compression retained.
- File: `placenames.json.gz`.

The original data creators do not endorse this clone. All transformations and
the clone implementation are the responsibility of this project.
