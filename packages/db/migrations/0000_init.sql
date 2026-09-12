CREATE TYPE "public"."fingerprint_kind" AS ENUM('url', 'address', 'fuzzy');--> statement-breakpoint
CREATE TYPE "public"."furnished" AS ENUM('bare', 'upholstered', 'furnished');--> statement-breakpoint
CREATE TYPE "public"."geo_precision" AS ENUM('exact', 'postcode');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('new', 'seen', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."property_type" AS ENUM('apartment', 'house', 'studio', 'room');--> statement-breakpoint
CREATE TYPE "public"."registration_mode" AS ENUM('required', 'preferred', 'any');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dedup_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" "fingerprint_kind" NOT NULL,
	"score" double precision,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"source_listing_id" text NOT NULL,
	"canonical_url" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"title" text,
	"address_raw" text,
	"street" text,
	"house_number" text,
	"postcode" text,
	"city" text,
	"lat" double precision,
	"lng" double precision,
	"geo_precision" "geo_precision",
	"price_base_cents" integer,
	"price_total_cents" integer,
	"price_includes" text[],
	"deposit_cents" integer,
	"area_sqm" integer,
	"rooms" integer,
	"bedrooms" integer,
	"property_type" "property_type",
	"furnished" "furnished",
	"available_from" date,
	"min_contract_months" integer,
	"registration_allowed" boolean,
	"pets_allowed" boolean,
	"income_requirement_multiple" numeric,
	"agency_name" text,
	"agency_fee_flagged" boolean,
	"raw_payload" jsonb,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gone_at" timestamp with time zone,
	CONSTRAINT "listings_source_listing_unique" UNIQUE("source_id","source_listing_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"search_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "match_status" DEFAULT 'new' NOT NULL,
	CONSTRAINT "matches_search_property_unique" UNIQUE("search_id","property_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"search_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "notifications_search_property_channel_unique" UNIQUE("search_id","property_id","channel")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint_kind" "fingerprint_kind",
	"postcode" text,
	"house_number" text,
	"representative_listing_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "property_listings" (
	"property_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	CONSTRAINT "property_listings_property_id_listing_id_pk" PRIMARY KEY("property_id","listing_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saved_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"cities" text[],
	"price_total_min_cents" integer,
	"price_total_max_cents" integer,
	"area_sqm_min" integer,
	"rooms_min" integer,
	"furnished" "furnished"[],
	"property_types" "property_type"[],
	"registration" "registration_mode" DEFAULT 'any' NOT NULL,
	"telegram_chat_id" text,
	"work_address" text,
	"work_lat" double precision,
	"work_lng" double precision,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"listings_seen" integer,
	"listings_new" integer,
	"error" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dedup_decisions" ADD CONSTRAINT "dedup_decisions_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dedup_decisions" ADD CONSTRAINT "dedup_decisions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "matches" ADD CONSTRAINT "matches_search_id_saved_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."saved_searches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "matches" ADD CONSTRAINT "matches_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_search_id_saved_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."saved_searches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "properties" ADD CONSTRAINT "properties_representative_listing_id_listings_id_fk" FOREIGN KEY ("representative_listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "property_listings" ADD CONSTRAINT "property_listings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "property_listings" ADD CONSTRAINT "property_listings_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
