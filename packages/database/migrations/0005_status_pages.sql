CREATE TABLE "status_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_page_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status_page_id" uuid NOT NULL,
	"title" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_page_groups_page_position_unique" UNIQUE("status_page_id","position"),
	CONSTRAINT "status_page_groups_id_page_unique" UNIQUE("id","status_page_id"),
	CONSTRAINT "status_page_groups_position_nonnegative" CHECK ("status_page_groups"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "status_page_monitors" (
	"status_page_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_page_monitors_status_page_id_monitor_id_pk" PRIMARY KEY("status_page_id","monitor_id"),
	CONSTRAINT "status_page_monitors_group_position_unique" UNIQUE("group_id","position"),
	CONSTRAINT "status_page_monitors_position_nonnegative" CHECK ("status_page_monitors"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "status_page_groups" ADD CONSTRAINT "status_page_groups_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "status_page_monitors" ADD CONSTRAINT "status_page_monitors_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "status_page_monitors" ADD CONSTRAINT "status_page_monitors_group_id_status_page_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."status_page_groups"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "status_page_monitors" ADD CONSTRAINT "status_page_monitors_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "status_page_monitors" ADD CONSTRAINT "status_page_monitors_group_page_fk" FOREIGN KEY ("group_id","status_page_id") REFERENCES "public"."status_page_groups"("id","status_page_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "status_page_monitors_monitor_idx" ON "status_page_monitors" USING btree ("monitor_id");
