// The page a shared link lands on: the receipt, and the way in. Crawlers read its meta tags,
// people read the card. `blind` is the honest version for when the engine could not be asked: the
// brand card and a sentence, instead of a 404 that a crawler would cache as "nothing here".
import { SITE_URL } from "@/lib/site";

/** The composer, prefilled: whoever lands here can pass it on without retyping the numbers.
 *  One cashtag per post (X refuses two), and always the canonical www URL. */
const postUrl = (text: string, path: string) =>
  `https://x.com/intent/post?${new URLSearchParams({ text, url: `${SITE_URL}${path}` }).toString()}`;

export function SharePage({
  image,
  alt,
  commitment,
  blind,
  post,
}: {
  image: string;
  alt: string;
  commitment?: string;
  blind?: boolean;
  post?: { text: string; path: string };
}) {
  return (
    <main id="main" className="share">
      <div className="wrap share__wrap">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="share__card" src={image} alt={alt} width={1200} height={630} />
        {blind && (
          <p className="share__note" role="status">
            The engine didn&apos;t answer, so this receipt can&apos;t be drawn right now. Reload in a minute: what
            was committed on-chain doesn&apos;t change while you wait.
          </p>
        )}
        <div className="share__actions">
          {post && (
            <a className="btn" href={postUrl(post.text, post.path)} rel="noopener" target="_blank">
              Post it on X
            </a>
          )}
          <a className={post ? "btn btn--ghost" : "btn"} href="/#play">
            Make your own call
          </a>
          {commitment && (
            <a className="btn btn--ghost" href={commitment}>
              Check the commitment
            </a>
          )}
        </div>
      </div>
    </main>
  );
}
