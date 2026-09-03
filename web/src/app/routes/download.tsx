import { createFileRoute } from "@tanstack/react-router";
import { DownloadPage } from "@/features/download/ui/DownloadPage";

export const Route = createFileRoute("/download")({ component: DownloadPage });
