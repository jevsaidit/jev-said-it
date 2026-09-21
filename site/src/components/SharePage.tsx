// The page a shared link lands on: the receipt, and the way in. Crawlers read its meta tags,
// people read the card.
export function SharePage({ image, alt, commitment }: { image: string; alt: string; commitment?: string }) {
  return (
    <main id="main" className="share">
      <div className="wrap share__wrap">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="share__card" src={image} alt={alt} width={1200} height={630} />
        <div className="share__actions">
          <a className="btn" href="/#play">
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
