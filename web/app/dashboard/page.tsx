import { redirect } from "next/navigation";

/** The dashboard is the main page now — keep the old URL working. */
export default function DashboardRedirect() {
  redirect("/");
}
