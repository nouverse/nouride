import { createFileRoute } from "@tanstack/react-router";
import TransferPage from "@/modules/transfer/index.page";

export const Route = createFileRoute("/transfer")({ component: TransferPage });
