import { base } from "@watchdog/eslint-config/base";
import { defineConfig } from "eslint/config";

export default defineConfig(base(import.meta.dirname));
