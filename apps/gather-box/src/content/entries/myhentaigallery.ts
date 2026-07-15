import { collectMyHentaiGalleryData } from "../collectors/my-hentai-gallery";
import { installCollector } from "../collector-entry";

installCollector("myhentaigallery", collectMyHentaiGalleryData);
