// Tabelas do Rastro. Todas as instruções são idempotentes (create ... if not exists).
module.exports = [
  `create table if not exists visitors (
    id text primary key,
    first_seen timestamptz not null default now(),
    last_seen timestamptz not null default now(),
    fbp text, fbc text, ip text, ua text,
    first_attr jsonb, last_attr jsonb
  )`,

  `create table if not exists touches (
    id bigserial primary key,
    visitor_id text,
    type text not null,
    ref_code text,
    channel text,
    url text, referrer text,
    utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text,
    ad_id text, adset_id text, campaign_id text, fbclid text,
    link_slug text,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists touches_ref_idx on touches (ref_code)`,
  `create index if not exists touches_visitor_idx on touches (visitor_id)`,
  `create index if not exists touches_created_idx on touches (created_at)`,

  `create table if not exists leads (
    id bigserial primary key,
    phone text unique,
    name text,
    email text,
    origin text not null default 'direct',
    channel text,
    utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text,
    ad_id text, adset_id text, campaign_id text,
    ad_headline text, ad_source_url text,
    fbclid text, fbc text, fbp text, ctwa_clid text,
    ip text, ua text,
    landing_url text,
    ref_code text,
    link_slug text,
    visitor_id text,
    ghl_contact_id text,
    stage text,
    status text not null default 'lead',
    revenue numeric(14,2) not null default 0,
    sales_count int not null default 0,
    first_message text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create index if not exists leads_created_idx on leads (created_at)`,
  `create index if not exists leads_email_idx on leads (lower(email))`,
  `create index if not exists leads_ad_idx on leads (ad_id)`,

  `create table if not exists events (
    id bigserial primary key,
    lead_id bigint references leads(id) on delete cascade,
    type text not null,
    data jsonb,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists events_lead_idx on events (lead_id)`,
  `create index if not exists events_type_created_idx on events (type, created_at)`,

  `create table if not exists links (
    slug text primary key,
    name text not null,
    channel text,
    kind text not null default 'whatsapp',
    destination text,
    wa_phone text,
    wa_message text,
    utm_source text, utm_medium text, utm_campaign text,
    clicks int not null default 0,
    created_at timestamptz not null default now()
  )`,

  `create table if not exists webhook_logs (
    id bigserial primary key,
    source text not null,
    status text,
    payload jsonb,
    created_at timestamptz not null default now()
  )`,
];
