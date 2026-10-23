// Names and order for the platform totals catalogue. The API's `type` and
// `areas` values are identifiers, not labels: the server hands us the labels
// it has (data/platform-labels.json); anything unknown reads as words.
let catalogue = { types: {}, areas: {}, areaOrder: [], keyFigures: [] };

export const setCatalogue = (c) => {
  catalogue = { types: c?.types || {}, areas: c?.areas || {}, areaOrder: c?.areaOrder || [], keyFigures: c?.keyFigures || [] };
};

/** The areas of these figures: the catalogue's order first, then any other as they appear. */
export const orderedAreas = (totals) => {
  const present = [...new Set(totals.flatMap((x) => x.areas))];
  return [...catalogue.areaOrder.filter((a) => present.includes(a)), ...present.filter((a) => !catalogue.areaOrder.includes(a))];
};

/** The figures the overview shows by default. */
export const keyFigures = () => catalogue.keyFigures;

// A type we don't know yet ("newThing") still reads as words ("New thing").
const humanize = (id) => id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (c) => c.toUpperCase());

export const figureLabel = (type) => catalogue.types[type] || humanize(type);
export const areaLabel = (area) => catalogue.areas[area] || humanize(area);
