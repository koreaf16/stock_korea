import { redirect } from "next/navigation";

export default function TelegramSettingsPage() {
  redirect("/settings/zone0?tab=telegram");
}
