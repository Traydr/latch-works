Here is my problem:

I have a lot of archived media that I want to view and interact with in multiple ways. The media exists in a variety of formats in images, gifs, videos and archived stories as pdfs. The desktop app that I created for myself `Frame View` currently handles all of the behaviours that I want from it for all the media formats, it has a variety of features like recursive image viewing, comic grouping and viewing, video controls, etc. I use my Content Downloader extension to download the content I want and arrange it locally like I want. I have a local folder with all this media and I use Tresorit to backup up it to the cloud. My laptop essentially acts as the main source of truth right now.

So here comes the problem: Tresorit has a mobile app for ipad and iPhone that I currently use to view that archived content and it doesn't really conform with the way I use the app. I want the app to behave more like my frame view desktop app (essentially I only care for a read-only viewer experience) with all the convienent features I've added to the frame view app. This doesn't exist in the tresorit app and I couldn't use it as a file sync on my mobile devices anyway because of apples app sandboxing.

So what do I want: 

I want to have essentially a web viewer that is very similar in the ui/ux of frame view in the web. But I also want to consolidate all of these separate projects into one monorepo so that they all live together.

What do I want you to do:

You are currently in an empty folder, mostly because the actual project / monorepo hasn't been architected yet. I want you to construct an in-depth plan for what I've explained so far. This plan should then be written to the current folder. Feel free to ask questions so that we are very clear on all aspects of this plan.

Consideration I've already thought about:

- The website does not need to be actively synced with my current files. If tresorit has some kind of solution for this then great, but im also completely fine with have to push all my new files from my local computer to the website. (Something like some syncing CLI)
- This website and access to the content absolutely needs to be authed since some of these files are not public
- I will be useing railway to deploy this application so you may use any of the currently available services in the plans like their cdn or their docker volumes, etc. check their docs for this.
- For the website I will want to be using tanstack start as the framework and will have to use a bunch of the tanstack libraries for the functionality, some of which we already use in the app.

The related projects mentioned:

Frame view a desktop gallery viewer galore - C:\Users\Trayd\dev\frame-view
Content Downloader chrome extension that has a variety of supported sites - C:\Users\Trayd\dev\comic-downloader