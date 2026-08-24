-- Seeds the three physical products currently shown on the site.
--
-- Names, descriptions and images are taken verbatim from the "Our Products
-- and Services" section of index.html so the storefront matches the page.
--
-- Prices are deliberately left null. Frank is supplying them separately, and
-- the storefront hides Add to Basket for any product without a price, so
-- seeding a placeholder price would risk selling an item for the wrong amount.
--
-- The remaining two cards, Wellness Consulting and THz/HPT Therapy, are not
-- seeded here. They are services and route to the consultation booking flow.
--
-- The socks have no product copy of their own on the site: their image is
-- currently borrowed by the Wellness Consulting service card, whose wording
-- describes consulting rather than socks. The description below is a factual
-- placeholder and wants replacing with Frank's own copy.

insert into public.products (slug, name, description, image_path, sort_order)
values
  (
    'wellness-harlequin-check-socks',
    'Wellness Harlequin Check Socks',
    'Harlequin check wellness socks, made for everyday comfort and support.',
    'wellness harlequin check socks.jpeg',
    5
  ),
  (
    'traditional-herbal-remedies',
    'Traditional Herbal Remedies',
    'Curated herbal blends grounded in historical efficacy and modern understanding to restore your natural balance.',
    'vox stasis liner.jpeg',
    10
  ),
  (
    'prife-ring',
    'Prife Ring',
    'A premium wellness accessory integrating advanced frequency harmonization for subtle, continuous performance enhancement.',
    'prife ring.jpeg',
    20
  ),
  (
    'prife-frequency-device',
    'Prife Frequency Device',
    'State-of-the-art technology that aligns your body''s natural energetic frequencies, ensuring peak synchronization and recovery.',
    'prife002.jpeg',
    30
  )
on conflict (slug) do nothing;
