import { collectHentaiFoundryStoriesData } from "../collectors/hentai-foundry-stories";
import { installCollector } from "../collector-entry";

installCollector("hentaifoundry-stories", collectHentaiFoundryStoriesData);
