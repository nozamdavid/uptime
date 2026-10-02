ALTER TABLE "monitors" DROP CONSTRAINT "monitors_interval_preset";
--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_interval_preset" CHECK ("monitors"."interval_seconds" in (60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3300, 3600));
--> statement-breakpoint
CREATE TABLE "monitor_daily_uptime" (
	"monitor_id" uuid NOT NULL,
	"day" date NOT NULL,
	"uptime_percentage" double precision NOT NULL,
	"average_response_ms" double precision,
	"weight" double precision DEFAULT 1 NOT NULL,
	"received_count" integer,
	"success_count" integer,
	"source" text DEFAULT 'calculated' NOT NULL,
	"finalized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitor_daily_uptime_monitor_id_day_pk" PRIMARY KEY("monitor_id","day"),
	CONSTRAINT "monitor_daily_uptime_percentage_range" CHECK ("monitor_daily_uptime"."uptime_percentage" between 0 and 100),
	CONSTRAINT "monitor_daily_uptime_average_response_nonnegative" CHECK ("monitor_daily_uptime"."average_response_ms" is null or "monitor_daily_uptime"."average_response_ms" >= 0),
	CONSTRAINT "monitor_daily_uptime_weight_positive" CHECK ("monitor_daily_uptime"."weight" > 0),
	CONSTRAINT "monitor_daily_uptime_counts_consistent" CHECK (("monitor_daily_uptime"."received_count" is null and "monitor_daily_uptime"."success_count" is null) or ("monitor_daily_uptime"."received_count" > 0 and "monitor_daily_uptime"."success_count" between 0 and "monitor_daily_uptime"."received_count"))
);
--> statement-breakpoint
ALTER TABLE "monitor_daily_uptime" ADD CONSTRAINT "monitor_daily_uptime_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "monitor_daily_uptime_day_idx" ON "monitor_daily_uptime" USING btree ("day","monitor_id");
