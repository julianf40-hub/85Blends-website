// Image references in a catalog, and the content-addressed gear storage naming scheme.
// Real naming (planned gear-upload-url function): recommended-gear/images/<brandId>/<sha256>.<ext>
// served from the public bucket. The prototype uses the reserved .invalid host so nothing can
// ever resolve on the network; the local server serves the same files from /images/<sha>.<ext>.

export const STORAGE_IMAGE_PREFIX = 'https://storage.example.invalid/recommended-gear/images/';
// PNG and JPEG only: HEIF/HEIC uploads are disabled until server-side decoding exists.
const STORAGE_PATTERN = /^https:\/\/storage\.example\.invalid\/recommended-gear\/images\/([a-z0-9-]{1,64})\/([a-f0-9]{64}\.(?:png|jpg))$/;

export function storageImageKey(url) {
  const match = STORAGE_PATTERN.exec(String(url ?? ''));
  return match ? { brand: match[1], file: match[2] } : null;
}

/** Local preview source for a catalog image URL, or null if the prototype must not load it. */
export function previewSource(url) {
  const key = storageImageKey(url);
  return key ? `/images/${key.file}` : null;
}

export function imageReferences(catalog) {
  const refs = [];
  (catalog?.brands ?? []).forEach((brand, i) => {
    const name = brand.name || brand.id;
    if (brand.logo?.url) refs.push({ path: `brands[${i}].logo.url`, label: `${name} logo`, url: brand.logo.url });
    if (brand.logo?.darkURL) refs.push({ path: `brands[${i}].logo.darkURL`, label: `${name} dark logo`, url: brand.logo.darkURL });
    if (brand.heroImageURL) refs.push({ path: `brands[${i}].heroImageURL`, label: `${name} product image`, url: brand.heroImageURL });
    (brand.wheels ?? []).forEach((wheel, w) => {
      if (wheel.imageURL) refs.push({ path: `brands[${i}].wheels[${w}].imageURL`, label: `${wheel.displayName || wheel.id} image`, url: wheel.imageURL });
    });
  });
  return refs;
}
