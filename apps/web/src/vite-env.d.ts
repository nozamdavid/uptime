/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute API root including the `/api` suffix, or unset for `/api`. */
  readonly VITE_API_BASE_URL?: string;
  /** Public report origin (no trailing slash), or unset to use the API. */
  readonly VITE_REPORTS_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
