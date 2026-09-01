import { createFileRoute } from "@tanstack/react-router";
import { HiveChatPage } from "@/features/chat/ui/HiveChatPage";

export const Route = createFileRoute("/app")({ component: HiveChatPage });
