import { Route, Routes } from "react-router-dom";
import { SiteLayout } from "@/components/layout";
import { HomePage } from "@/pages/home";
import { ProductPage } from "@/pages/product";

export function App() {
  return (
    <SiteLayout>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/:slug" element={<ProductPage />} />
      </Routes>
    </SiteLayout>
  );
}
