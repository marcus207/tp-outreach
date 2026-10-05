-- =====================================================================
-- tp-outreach INTEGRATION TEST schema (tpca_outreach_test ONLY)
--
-- Generated 2026-10-05 from prod tpca_platform with:
--   pg_dump --schema-only --no-owner --no-privileges -t <outreach tables>
-- Outreach tables only (every table referenced by src/ FROM/INTO/UPDATE/JOIN).
-- Plus the test-only `test_outbox` table at the bottom (never exists in prod).
--
-- Regenerate: see test/README.md ("Refreshing the schema").
-- Load via scripts/test-db-reset.sh, which refuses any other database.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: _migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._migrations (
    id integer NOT NULL,
    filename character varying(255) NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: _migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public._migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: _migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public._migrations_id_seq OWNED BY public._migrations.id;


--
-- Name: apollo_sync_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apollo_sync_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sync_type character varying(20) NOT NULL,
    status character varying(20) NOT NULL,
    contacts_added integer DEFAULT 0,
    contacts_updated integer DEFAULT 0,
    error_message text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: article_broadcasts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_broadcasts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    article_id uuid NOT NULL,
    subsectors text[] NOT NULL,
    contact_type character varying(20),
    total_contacts integer DEFAULT 0,
    total_sent integer DEFAULT 0,
    total_opened integer DEFAULT 0,
    total_clicked integer DEFAULT 0,
    status character varying(20) DEFAULT 'pending'::character varying,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: article_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title character varying(500) NOT NULL,
    slug character varying(300) NOT NULL,
    excerpt text,
    content text,
    sector character varying(50) DEFAULT 'general'::character varying,
    author character varying(100) DEFAULT 'Marcus Emadi'::character varying,
    publish_date date,
    source_url text,
    source_org character varying(100) DEFAULT 'Research'::character varying,
    status character varying(20) DEFAULT 'draft'::character varying,
    strapi_id character varying(100),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    tenant character varying(50) DEFAULT 'tp'::character varying,
    published_at timestamp with time zone,
    scheduled_publish_at timestamp with time zone,
    scheduled_broadcast_at timestamp with time zone,
    broadcast_subsectors text[],
    sequence_order integer,
    hero_image text
);


--
-- Name: campaign_schedule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_schedule (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant text DEFAULT 'tp'::text NOT NULL,
    sector text NOT NULL,
    send_number integer NOT NULL,
    hero_image text DEFAULT 'london_skyline.jpg'::text NOT NULL,
    subject_line text DEFAULT ''::text NOT NULL,
    body_copy text DEFAULT ''::text NOT NULL,
    article_slug text,
    article_title text,
    article_excerpt text,
    template_id uuid,
    status text DEFAULT 'draft'::text NOT NULL,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaign_schedule_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'sent'::text, 'skipped'::text])))
);


--
-- Name: campaign_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_sends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    schedule_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    email_send_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaign_sends_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: campaign_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant text DEFAULT 'tp'::text NOT NULL,
    frequency_days integer DEFAULT 30 NOT NULL,
    start_date date DEFAULT '2026-05-01'::date NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contact_list_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_list_members (
    list_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant text DEFAULT 'tp'::text NOT NULL
);


--
-- Name: contact_lists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_lists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    apollo_list_id character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant text DEFAULT 'tp'::text NOT NULL
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apollo_id character varying(255),
    email character varying(255) NOT NULL,
    first_name character varying(255),
    last_name character varying(255),
    title character varying(500),
    company character varying(500),
    company_domain character varying(255),
    linkedin_url character varying(500),
    phone character varying(100),
    city character varying(255),
    country character varying(255),
    tags text[] DEFAULT '{}'::text[],
    custom_fields jsonb DEFAULT '{}'::jsonb,
    email_verified boolean DEFAULT false,
    source character varying(50) DEFAULT 'apollo'::character varying NOT NULL,
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant text DEFAULT 'tp'::text NOT NULL,
    contact_type character varying(50),
    classification_data jsonb DEFAULT '{}'::jsonb,
    classified_at timestamp with time zone,
    subsector character varying(50)
);


--
-- Name: daily_digest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_digest (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    digest_date date NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    contacts jsonb DEFAULT '[]'::jsonb NOT NULL,
    approved_contacts jsonb,
    approval_token uuid DEFAULT gen_random_uuid() NOT NULL,
    approved_at timestamp with time zone,
    sent_at timestamp with time zone,
    emails_sent integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    digest_gmail_thread_id character varying(255),
    digest_from_account_id uuid,
    reply_processed_at timestamp with time zone,
    tenant text DEFAULT 'tp'::text NOT NULL
);


--
-- Name: daily_send_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_send_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant text NOT NULL,
    plan_date date NOT NULL,
    plan_hour integer DEFAULT 0 NOT NULL,
    planned_at timestamp with time zone DEFAULT now() NOT NULL,
    total_planned integer DEFAULT 0 NOT NULL,
    total_skipped integer DEFAULT 0 NOT NULL,
    account_distribution jsonb DEFAULT '{}'::jsonb NOT NULL,
    overflow_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: deliverability_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deliverability_checks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    checked_at timestamp with time zone DEFAULT now(),
    overall_score numeric(3,1),
    spf_score integer,
    spf_status character varying(10),
    spf_record text,
    spf_issues jsonb DEFAULT '[]'::jsonb,
    dkim_score integer,
    dkim_status character varying(10),
    dkim_selector character varying(50),
    dkim_issues jsonb DEFAULT '[]'::jsonb,
    dmarc_score integer,
    dmarc_status character varying(10),
    dmarc_record text,
    dmarc_issues jsonb DEFAULT '[]'::jsonb,
    blacklist_score integer,
    blacklist_status character varying(10),
    blacklist_listed jsonb DEFAULT '[]'::jsonb,
    blacklist_clean integer,
    blacklist_total integer,
    rdns_score integer,
    rdns_status character varying(10),
    rdns_ptr text,
    total_sent_7d integer,
    open_rate_7d numeric(5,1),
    unsubscribes_7d integer,
    account_stats jsonb DEFAULT '[]'::jsonb,
    tenant text DEFAULT 'tp'::text
);


--
-- Name: dmarc_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dmarc_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant character varying(50) DEFAULT 'tp'::character varying NOT NULL,
    org_name character varying(255) NOT NULL,
    report_id character varying(500),
    domain character varying(255) NOT NULL,
    date_begin timestamp with time zone NOT NULL,
    date_end timestamp with time zone NOT NULL,
    policy character varying(50),
    pct integer,
    total_messages integer DEFAULT 0 NOT NULL,
    pass_count integer DEFAULT 0 NOT NULL,
    fail_count integer DEFAULT 0 NOT NULL,
    spf_pass integer DEFAULT 0 NOT NULL,
    spf_fail integer DEFAULT 0 NOT NULL,
    dkim_pass integer DEFAULT 0 NOT NULL,
    dkim_fail integer DEFAULT 0 NOT NULL,
    source_ips jsonb DEFAULT '[]'::jsonb,
    raw_records jsonb DEFAULT '[]'::jsonb,
    gmail_message_id character varying(255),
    gmail_account character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dripify_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dripify_alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    alert_type character varying(50) NOT NULL,
    message text NOT NULL,
    severity character varying(20) DEFAULT 'warning'::character varying NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    snapshot_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dripify_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dripify_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    snapshot_data jsonb NOT NULL,
    search_credits integer,
    daily_invites_used integer,
    daily_invites_limit integer,
    daily_messages_used integer,
    daily_messages_limit integer,
    campaigns jsonb,
    scraped_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    display_name character varying(255),
    oauth_tokens jsonb NOT NULL,
    daily_limit integer DEFAULT 2000 NOT NULL,
    hourly_limit integer DEFAULT 50 NOT NULL,
    sends_today integer DEFAULT 0 NOT NULL,
    sends_this_hour integer DEFAULT 0 NOT NULL,
    last_send_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant text DEFAULT 'tp'::text NOT NULL,
    broadcast_sends_this_hour integer DEFAULT 0 NOT NULL,
    broadcast_hourly_limit integer DEFAULT 15 NOT NULL
);


--
-- Name: email_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email_send_id uuid NOT NULL,
    event_type character varying(20) NOT NULL,
    url text,
    ip_address character varying(45),
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_sends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    enrollment_id uuid,
    sequence_step_id uuid,
    contact_id uuid,
    email_account_id uuid NOT NULL,
    template_id uuid,
    to_email character varying(255) NOT NULL,
    from_email character varying(255) NOT NULL,
    subject character varying(500) NOT NULL,
    body_html text NOT NULL,
    gmail_message_id character varying(255),
    gmail_thread_id character varying(255),
    tracking_id character varying(64) DEFAULT encode(public.gen_random_bytes(32), 'hex'::text) NOT NULL,
    status character varying(20) DEFAULT 'queued'::character varying NOT NULL,
    sent_at timestamp with time zone,
    error_message text,
    ab_variant character(1),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant text DEFAULT 'tp'::text NOT NULL,
    broadcast_id uuid,
    send_type text DEFAULT 'sequence'::text NOT NULL,
    last_enqueued_at timestamp with time zone
);


--
-- Name: gmail_scanned_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gmail_scanned_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    gmail_message_id character varying(255) NOT NULL,
    direction character varying(10) NOT NULL,
    contact_email character varying(255),
    scanned_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant character varying(50) DEFAULT 'tp'::character varying NOT NULL,
    CONSTRAINT gmail_scanned_messages_direction_check CHECK (((direction)::text = ANY ((ARRAY['sent'::character varying, 'received'::character varying])::text[])))
);


--
-- Name: kv_store; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kv_store (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: press_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.press_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    publication character varying(255) NOT NULL,
    publication_url character varying(500),
    contact_name character varying(255),
    contact_role character varying(255),
    email character varying(255) NOT NULL,
    focus_notes text,
    is_primary boolean DEFAULT false,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: press_releases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.press_releases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    announcement_title character varying(500) NOT NULL,
    publication character varying(255) NOT NULL,
    press_contact_id uuid,
    headline character varying(500) NOT NULL,
    subheadline character varying(500),
    dateline character varying(255),
    body text NOT NULL,
    spokesperson_name character varying(255) DEFAULT 'Kassi Emadi'::character varying,
    spokesperson_title character varying(255) DEFAULT 'CEO, Loan Intel'::character varying,
    spokesperson_quote text,
    boilerplate text DEFAULT 'Loan Intel is a lender intelligence platform purpose-built for UK commercial real estate lending. The platform provides deal-level transparency, lender benchmarking, sponsor screening, and market analytics to help lenders make faster, better-informed credit decisions. For more information visit www.loan-intel.com or contact support@loan-intel.com.'::text,
    notes_to_editors text,
    status character varying(50) DEFAULT 'draft'::character varying,
    sent_at timestamp without time zone,
    email_send_id uuid,
    tenant character varying(50) DEFAULT 'loan-intel'::character varying,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: sequence_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequence_enrollments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sequence_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    current_step integer DEFAULT 0 NOT NULL,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    replied_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant text DEFAULT 'tp'::text NOT NULL,
    next_step_number integer,
    next_step_due_at timestamp with time zone
);


--
-- Name: sequence_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequence_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sequence_id uuid NOT NULL,
    step_number integer NOT NULL,
    template_id uuid,
    delay_days integer DEFAULT 0 NOT NULL,
    delay_hours integer DEFAULT 0 NOT NULL,
    step_type character varying(20) DEFAULT 'email'::character varying NOT NULL,
    variant_template_id uuid,
    variant_split integer DEFAULT 50,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant text DEFAULT 'tp'::text NOT NULL,
    sector text,
    subject_line text,
    body_copy text,
    hero_image text DEFAULT 'london_skyline.jpg'::text,
    article_slug text,
    article_title text,
    article_excerpt text,
    blast_status text DEFAULT 'draft'::text
);


--
-- Name: sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    sending_account_ids uuid[] DEFAULT '{}'::uuid[],
    send_window_start time without time zone DEFAULT '08:00:00'::time without time zone,
    send_window_end time without time zone DEFAULT '18:00:00'::time without time zone,
    skip_weekends boolean DEFAULT true NOT NULL,
    daily_send_limit integer DEFAULT 100,
    stop_on_reply boolean DEFAULT true NOT NULL,
    stop_on_open boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant text DEFAULT 'tp'::text NOT NULL,
    type text DEFAULT 'drip'::text NOT NULL,
    frequency_days integer,
    start_date date
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    sid character varying NOT NULL,
    sess json NOT NULL,
    expire timestamp(6) without time zone NOT NULL
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    key character varying(255) NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: suppressed_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suppressed_emails (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    domain text,
    reason text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    tenant text NOT NULL,
    suppressed_at timestamp with time zone DEFAULT now() NOT NULL,
    suppressed_by text
);


--
-- Name: template_draft_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_draft_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant text DEFAULT 'tp'::text NOT NULL,
    theme character varying(100) NOT NULL,
    season character varying(20) NOT NULL,
    week_start date NOT NULL,
    round smallint DEFAULT 1 NOT NULL,
    email_subject character varying(500) NOT NULL,
    email_html text NOT NULL,
    linkedin_content text,
    image_url text,
    gmail_thread_id character varying(255),
    gmail_message_id character varying(255),
    from_account_id uuid,
    approval_token uuid DEFAULT gen_random_uuid() NOT NULL,
    skip_token uuid DEFAULT gen_random_uuid() NOT NULL,
    status character varying(30) DEFAULT 'drafting'::character varying NOT NULL,
    feedback_1 text,
    feedback_2 text,
    approved_at timestamp with time zone,
    sent_at timestamp with time zone,
    emails_sent integer DEFAULT 0 NOT NULL,
    reply_processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    email_content_json jsonb,
    linkedin_poster_html text
);


--
-- Name: template_rotations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_rotations (
    id integer NOT NULL,
    list_name character varying(100) NOT NULL,
    rotation_index integer NOT NULL,
    template_id uuid NOT NULL,
    label character varying(100)
);


--
-- Name: template_rotations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.template_rotations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: template_rotations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.template_rotations_id_seq OWNED BY public.template_rotations.id;


--
-- Name: templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    subject character varying(500) NOT NULL,
    body_html text NOT NULL,
    body_text text,
    merge_fields text[] DEFAULT '{}'::text[],
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant text DEFAULT 'tp'::text NOT NULL,
    "position" integer,
    linkedin_content text,
    linkedin_poster_html text
);


--
-- Name: _migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._migrations ALTER COLUMN id SET DEFAULT nextval('public._migrations_id_seq'::regclass);


--
-- Name: template_rotations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_rotations ALTER COLUMN id SET DEFAULT nextval('public.template_rotations_id_seq'::regclass);


--
-- Name: _migrations _migrations_filename_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._migrations
    ADD CONSTRAINT _migrations_filename_key UNIQUE (filename);


--
-- Name: _migrations _migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._migrations
    ADD CONSTRAINT _migrations_pkey PRIMARY KEY (id);


--
-- Name: apollo_sync_log apollo_sync_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apollo_sync_log
    ADD CONSTRAINT apollo_sync_log_pkey PRIMARY KEY (id);


--
-- Name: article_broadcasts article_broadcasts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_broadcasts
    ADD CONSTRAINT article_broadcasts_pkey PRIMARY KEY (id);


--
-- Name: article_drafts article_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_drafts
    ADD CONSTRAINT article_drafts_pkey PRIMARY KEY (id);


--
-- Name: article_drafts article_drafts_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_drafts
    ADD CONSTRAINT article_drafts_slug_key UNIQUE (slug);


--
-- Name: campaign_schedule campaign_schedule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_schedule
    ADD CONSTRAINT campaign_schedule_pkey PRIMARY KEY (id);


--
-- Name: campaign_schedule campaign_schedule_tenant_sector_send_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_schedule
    ADD CONSTRAINT campaign_schedule_tenant_sector_send_number_key UNIQUE (tenant, sector, send_number);


--
-- Name: campaign_sends campaign_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_sends
    ADD CONSTRAINT campaign_sends_pkey PRIMARY KEY (id);


--
-- Name: campaign_sends campaign_sends_schedule_id_contact_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_sends
    ADD CONSTRAINT campaign_sends_schedule_id_contact_id_key UNIQUE (schedule_id, contact_id);


--
-- Name: campaign_settings campaign_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_settings
    ADD CONSTRAINT campaign_settings_pkey PRIMARY KEY (id);


--
-- Name: campaign_settings campaign_settings_tenant_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_settings
    ADD CONSTRAINT campaign_settings_tenant_key UNIQUE (tenant);


--
-- Name: contact_list_members contact_list_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_list_members
    ADD CONSTRAINT contact_list_members_pkey PRIMARY KEY (list_id, contact_id);


--
-- Name: contact_lists contact_lists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_lists
    ADD CONSTRAINT contact_lists_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_apollo_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_apollo_id_key UNIQUE (apollo_id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: daily_digest daily_digest_digest_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_digest
    ADD CONSTRAINT daily_digest_digest_date_key UNIQUE (digest_date);


--
-- Name: daily_digest daily_digest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_digest
    ADD CONSTRAINT daily_digest_pkey PRIMARY KEY (id);


--
-- Name: daily_send_plans daily_send_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_send_plans
    ADD CONSTRAINT daily_send_plans_pkey PRIMARY KEY (id);


--
-- Name: deliverability_checks deliverability_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliverability_checks
    ADD CONSTRAINT deliverability_checks_pkey PRIMARY KEY (id);


--
-- Name: dmarc_reports dmarc_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dmarc_reports
    ADD CONSTRAINT dmarc_reports_pkey PRIMARY KEY (id);


--
-- Name: dmarc_reports dmarc_reports_tenant_report_id_org_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dmarc_reports
    ADD CONSTRAINT dmarc_reports_tenant_report_id_org_name_key UNIQUE (tenant, report_id, org_name);


--
-- Name: dripify_alerts dripify_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dripify_alerts
    ADD CONSTRAINT dripify_alerts_pkey PRIMARY KEY (id);


--
-- Name: dripify_snapshots dripify_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dripify_snapshots
    ADD CONSTRAINT dripify_snapshots_pkey PRIMARY KEY (id);


--
-- Name: email_accounts email_accounts_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_accounts
    ADD CONSTRAINT email_accounts_email_key UNIQUE (email);


--
-- Name: email_accounts email_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_accounts
    ADD CONSTRAINT email_accounts_pkey PRIMARY KEY (id);


--
-- Name: email_events email_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_events
    ADD CONSTRAINT email_events_pkey PRIMARY KEY (id);


--
-- Name: email_sends email_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sends
    ADD CONSTRAINT email_sends_pkey PRIMARY KEY (id);


--
-- Name: email_sends email_sends_tracking_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sends
    ADD CONSTRAINT email_sends_tracking_id_key UNIQUE (tracking_id);


--
-- Name: gmail_scanned_messages gmail_scanned_messages_account_id_gmail_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gmail_scanned_messages
    ADD CONSTRAINT gmail_scanned_messages_account_id_gmail_message_id_key UNIQUE (account_id, gmail_message_id);


--
-- Name: gmail_scanned_messages gmail_scanned_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gmail_scanned_messages
    ADD CONSTRAINT gmail_scanned_messages_pkey PRIMARY KEY (id);


--
-- Name: kv_store kv_store_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kv_store
    ADD CONSTRAINT kv_store_pkey PRIMARY KEY (key);


--
-- Name: press_contacts press_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.press_contacts
    ADD CONSTRAINT press_contacts_pkey PRIMARY KEY (id);


--
-- Name: press_releases press_releases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.press_releases
    ADD CONSTRAINT press_releases_pkey PRIMARY KEY (id);


--
-- Name: sequence_enrollments sequence_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_enrollments
    ADD CONSTRAINT sequence_enrollments_pkey PRIMARY KEY (id);


--
-- Name: sequence_enrollments sequence_enrollments_sequence_id_contact_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_enrollments
    ADD CONSTRAINT sequence_enrollments_sequence_id_contact_id_key UNIQUE (sequence_id, contact_id);


--
-- Name: sequence_steps sequence_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_steps
    ADD CONSTRAINT sequence_steps_pkey PRIMARY KEY (id);


--
-- Name: sequence_steps sequence_steps_sequence_id_step_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_steps
    ADD CONSTRAINT sequence_steps_sequence_id_step_number_key UNIQUE (sequence_id, step_number);


--
-- Name: sequences sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequences
    ADD CONSTRAINT sequences_pkey PRIMARY KEY (id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (sid);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: suppressed_emails suppressed_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppressed_emails
    ADD CONSTRAINT suppressed_emails_pkey PRIMARY KEY (id);


--
-- Name: template_draft_reviews template_draft_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_draft_reviews
    ADD CONSTRAINT template_draft_reviews_pkey PRIMARY KEY (id);


--
-- Name: template_rotations template_rotations_list_name_rotation_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_rotations
    ADD CONSTRAINT template_rotations_list_name_rotation_index_key UNIQUE (list_name, rotation_index);


--
-- Name: template_rotations template_rotations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_rotations
    ADD CONSTRAINT template_rotations_pkey PRIMARY KEY (id);


--
-- Name: templates templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.templates
    ADD CONSTRAINT templates_pkey PRIMARY KEY (id);


--
-- Name: IDX_session_expire; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_session_expire" ON public.session USING btree (expire);


--
-- Name: daily_digest_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_digest_date_idx ON public.daily_digest USING btree (digest_date DESC);


--
-- Name: daily_digest_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_digest_token_idx ON public.daily_digest USING btree (approval_token);


--
-- Name: idx_alerts_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_unread ON public.dripify_alerts USING btree (is_read) WHERE (is_read = false);


--
-- Name: idx_article_broadcasts_article; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_article_broadcasts_article ON public.article_broadcasts USING btree (article_id);


--
-- Name: idx_article_drafts_publish_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_article_drafts_publish_date ON public.article_drafts USING btree (publish_date DESC);


--
-- Name: idx_article_drafts_sector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_article_drafts_sector ON public.article_drafts USING btree (sector);


--
-- Name: idx_article_drafts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_article_drafts_status ON public.article_drafts USING btree (status);


--
-- Name: idx_article_drafts_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_article_drafts_tenant ON public.article_drafts USING btree (tenant);


--
-- Name: idx_campaign_schedule_sector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_schedule_sector ON public.campaign_schedule USING btree (tenant, sector, send_number);


--
-- Name: idx_campaign_sends_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_sends_contact ON public.campaign_sends USING btree (contact_id);


--
-- Name: idx_campaign_sends_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_sends_schedule ON public.campaign_sends USING btree (schedule_id);


--
-- Name: idx_contact_lists_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_lists_tenant ON public.contact_lists USING btree (tenant);


--
-- Name: idx_contacts_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_company ON public.contacts USING btree (company);


--
-- Name: idx_contacts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_contacts_email ON public.contacts USING btree (tenant, lower((email)::text));


--
-- Name: idx_contacts_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_source ON public.contacts USING btree (source);


--
-- Name: idx_contacts_subsector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_subsector ON public.contacts USING btree (subsector);


--
-- Name: idx_contacts_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_tags ON public.contacts USING gin (tags);


--
-- Name: idx_contacts_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_tenant ON public.contacts USING btree (tenant);


--
-- Name: idx_contacts_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_type ON public.contacts USING btree (contact_type);


--
-- Name: idx_contacts_type_subsector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_type_subsector ON public.contacts USING btree (contact_type, subsector);


--
-- Name: idx_contacts_unclassified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_unclassified ON public.contacts USING btree (created_at DESC) WHERE (contact_type IS NULL);


--
-- Name: idx_dmarc_reports_gmail_msg; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dmarc_reports_gmail_msg ON public.dmarc_reports USING btree (gmail_message_id);


--
-- Name: idx_dmarc_reports_tenant_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dmarc_reports_tenant_date ON public.dmarc_reports USING btree (tenant, date_end DESC);


--
-- Name: idx_dripify_scraped; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dripify_scraped ON public.dripify_snapshots USING btree (scraped_at DESC);


--
-- Name: idx_email_accounts_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_accounts_tenant ON public.email_accounts USING btree (tenant);


--
-- Name: idx_email_sends_enrollment_step; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_sends_enrollment_step ON public.email_sends USING btree (enrollment_id, sequence_step_id);


--
-- Name: idx_email_sends_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_sends_tenant ON public.email_sends USING btree (tenant);


--
-- Name: idx_enrollments_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrollments_contact ON public.sequence_enrollments USING btree (contact_id);


--
-- Name: idx_enrollments_planner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrollments_planner ON public.sequence_enrollments USING btree (tenant, next_step_due_at) WHERE (((status)::text = 'active'::text) AND (next_step_due_at IS NOT NULL));


--
-- Name: idx_enrollments_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrollments_sequence ON public.sequence_enrollments USING btree (sequence_id);


--
-- Name: idx_enrollments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrollments_status ON public.sequence_enrollments USING btree (status);


--
-- Name: idx_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_created ON public.email_events USING btree (created_at);


--
-- Name: idx_events_send; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_send ON public.email_events USING btree (email_send_id);


--
-- Name: idx_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_type ON public.email_events USING btree (event_type);


--
-- Name: idx_gmail_scanned_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gmail_scanned_account ON public.gmail_scanned_messages USING btree (account_id, scanned_at DESC);


--
-- Name: idx_gmail_scanned_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gmail_scanned_at ON public.gmail_scanned_messages USING btree (scanned_at DESC);


--
-- Name: idx_sends_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sends_contact ON public.email_sends USING btree (contact_id);


--
-- Name: idx_sends_enrollment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sends_enrollment ON public.email_sends USING btree (enrollment_id);


--
-- Name: idx_sends_gmail_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sends_gmail_thread ON public.email_sends USING btree (gmail_thread_id);


--
-- Name: idx_sends_sent_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sends_sent_at ON public.email_sends USING btree (sent_at);


--
-- Name: idx_sends_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sends_status ON public.email_sends USING btree (status);


--
-- Name: idx_sends_tracking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sends_tracking ON public.email_sends USING btree (tracking_id);


--
-- Name: idx_sequence_enrollments_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sequence_enrollments_tenant ON public.sequence_enrollments USING btree (tenant);


--
-- Name: idx_sequence_steps_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sequence_steps_sequence ON public.sequence_steps USING btree (sequence_id);


--
-- Name: idx_sequences_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sequences_tenant ON public.sequences USING btree (tenant);


--
-- Name: idx_sequences_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sequences_type ON public.sequences USING btree (type);


--
-- Name: idx_suppressed_emails_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppressed_emails_domain ON public.suppressed_emails USING btree (lower(domain));


--
-- Name: idx_suppressed_emails_email_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_suppressed_emails_email_tenant ON public.suppressed_emails USING btree (lower(email), tenant);


--
-- Name: idx_tdr_approval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tdr_approval ON public.template_draft_reviews USING btree (approval_token);


--
-- Name: idx_tdr_skip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tdr_skip ON public.template_draft_reviews USING btree (skip_token);


--
-- Name: idx_tdr_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tdr_status ON public.template_draft_reviews USING btree (status);


--
-- Name: idx_tdr_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tdr_tenant ON public.template_draft_reviews USING btree (tenant);


--
-- Name: idx_tdr_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tdr_thread ON public.template_draft_reviews USING btree (gmail_thread_id);


--
-- Name: idx_tdr_week; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tdr_week ON public.template_draft_reviews USING btree (week_start DESC);


--
-- Name: idx_templates_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_templates_tenant ON public.templates USING btree (tenant);


--
-- Name: article_broadcasts article_broadcasts_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_broadcasts
    ADD CONSTRAINT article_broadcasts_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.article_drafts(id) ON DELETE CASCADE;


--
-- Name: campaign_schedule campaign_schedule_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_schedule
    ADD CONSTRAINT campaign_schedule_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.templates(id);


--
-- Name: campaign_sends campaign_sends_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_sends
    ADD CONSTRAINT campaign_sends_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: campaign_sends campaign_sends_email_send_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_sends
    ADD CONSTRAINT campaign_sends_email_send_id_fkey FOREIGN KEY (email_send_id) REFERENCES public.email_sends(id);


--
-- Name: campaign_sends campaign_sends_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_sends
    ADD CONSTRAINT campaign_sends_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.campaign_schedule(id) ON DELETE CASCADE;


--
-- Name: contact_list_members contact_list_members_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_list_members
    ADD CONSTRAINT contact_list_members_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contact_list_members contact_list_members_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_list_members
    ADD CONSTRAINT contact_list_members_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.contact_lists(id) ON DELETE CASCADE;


--
-- Name: daily_digest daily_digest_digest_from_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_digest
    ADD CONSTRAINT daily_digest_digest_from_account_id_fkey FOREIGN KEY (digest_from_account_id) REFERENCES public.email_accounts(id);


--
-- Name: dripify_alerts dripify_alerts_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dripify_alerts
    ADD CONSTRAINT dripify_alerts_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.dripify_snapshots(id);


--
-- Name: email_events email_events_email_send_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_events
    ADD CONSTRAINT email_events_email_send_id_fkey FOREIGN KEY (email_send_id) REFERENCES public.email_sends(id) ON DELETE CASCADE;


--
-- Name: email_sends email_sends_broadcast_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sends
    ADD CONSTRAINT email_sends_broadcast_id_fkey FOREIGN KEY (broadcast_id) REFERENCES public.article_broadcasts(id) ON DELETE SET NULL;


--
-- Name: email_sends email_sends_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sends
    ADD CONSTRAINT email_sends_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);


--
-- Name: email_sends email_sends_email_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sends
    ADD CONSTRAINT email_sends_email_account_id_fkey FOREIGN KEY (email_account_id) REFERENCES public.email_accounts(id);


--
-- Name: email_sends email_sends_enrollment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sends
    ADD CONSTRAINT email_sends_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES public.sequence_enrollments(id) ON DELETE SET NULL;


--
-- Name: email_sends email_sends_sequence_step_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sends
    ADD CONSTRAINT email_sends_sequence_step_id_fkey FOREIGN KEY (sequence_step_id) REFERENCES public.sequence_steps(id) ON DELETE SET NULL;


--
-- Name: email_sends email_sends_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sends
    ADD CONSTRAINT email_sends_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.templates(id);


--
-- Name: gmail_scanned_messages gmail_scanned_messages_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gmail_scanned_messages
    ADD CONSTRAINT gmail_scanned_messages_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.email_accounts(id) ON DELETE CASCADE;


--
-- Name: press_releases press_releases_press_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.press_releases
    ADD CONSTRAINT press_releases_press_contact_id_fkey FOREIGN KEY (press_contact_id) REFERENCES public.press_contacts(id);


--
-- Name: sequence_enrollments sequence_enrollments_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_enrollments
    ADD CONSTRAINT sequence_enrollments_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: sequence_enrollments sequence_enrollments_sequence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_enrollments
    ADD CONSTRAINT sequence_enrollments_sequence_id_fkey FOREIGN KEY (sequence_id) REFERENCES public.sequences(id) ON DELETE CASCADE;


--
-- Name: sequence_steps sequence_steps_sequence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_steps
    ADD CONSTRAINT sequence_steps_sequence_id_fkey FOREIGN KEY (sequence_id) REFERENCES public.sequences(id) ON DELETE CASCADE;


--
-- Name: sequence_steps sequence_steps_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_steps
    ADD CONSTRAINT sequence_steps_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.templates(id);


--
-- Name: sequence_steps sequence_steps_variant_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_steps
    ADD CONSTRAINT sequence_steps_variant_template_id_fkey FOREIGN KEY (variant_template_id) REFERENCES public.templates(id);


--
-- Name: template_draft_reviews template_draft_reviews_from_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_draft_reviews
    ADD CONSTRAINT template_draft_reviews_from_account_id_fkey FOREIGN KEY (from_account_id) REFERENCES public.email_accounts(id) ON DELETE SET NULL;


--
-- Name: template_rotations template_rotations_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_rotations
    ADD CONSTRAINT template_rotations_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.templates(id);


--
-- PostgreSQL database dump complete
--



-- =====================================================================
-- TEST-ONLY: captured outbound mail. GmailClient.sendEmail() writes here
-- instead of calling Gmail when SEND_MODE!='live' and NODE_ENV='test'.
-- =====================================================================
CREATE TABLE public.test_outbox (
    id bigserial PRIMARY KEY,
    account_id uuid,
    account_email text NOT NULL,
    from_header text NOT NULL,
    from_email text NOT NULL,
    to_email text NOT NULL,
    reply_to text,
    subject text NOT NULL,
    html_body text NOT NULL,
    text_body text NOT NULL,
    headers jsonb NOT NULL,
    raw_message text NOT NULL,
    thread_id text,
    tracking_id text,
    fake_message_id text NOT NULL,
    fake_thread_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
