import { describe, expect, it } from "vitest";
import { INVENTORY_PHP } from "@/services/inventory/service";

describe("INVENTORY_PHP", () => {
  it("collects each theme's parent template", () => {
    expect(INVENTORY_PHP).toContain("'template' => $t->get_template()");
  });

  it("collects admin_url from WordPress rather than building it", () => {
    expect(INVENTORY_PHP).toContain("'admin_url' => admin_url()");
  });
});
