// The ticket (prep/WIREFRAMES.md section 6): one component with a `state`, used on the merchant form
// as a preview, on the claim page as the customer's card, and on the print sign.
import { capitalize, dayTime, usd, type Amount } from "@/lib/format";

export type CardState =
  | "preview" // the merchant form: fields fill in as the merchant types
  | "open" // a customer who is not covered yet
  | "full" // not covered, and every spot is taken
  | "closed" // not covered, and the promo has stopped taking customers
  | "covered"
  | "game-on" // covered, and the promo has stopped taking customers
  | "won" // the team won; the payout is on its way
  | "paid"
  | "lost"
  | "cancelled"
  | "review"; // the result is being checked

export type ReceiptCardProps = {
  state: CardState;
  /** The shop's name. "Your place" until the merchant has given one. */
  business?: string | null;
  /** What is free: "Wings". */
  item?: string | null;
  /** What each customer gets back, in base units. */
  amount?: Amount;
  /** "the Lions win": printed as FREE IF THE LIONS WIN. */
  condition?: string | null;
  /** "the Lions": the subject of the result lines. Empty when the event is not a game. */
  subject?: string | null;
  /** "Lions at Bears". */
  game?: string | null;
  /** Kickoff, unix seconds. */
  startTime?: number | null;
  claimCount?: number;
  maxClaims?: number;
  /** This customer's place in line. */
  customerNumber?: number | null;
  /** When the payout was sent, unix seconds. */
  paidAt?: number | null;
  /** True when this customer's payout did not go through and is set aside to be sent again. */
  waiting?: boolean;
  /**
   * True for a cover: the payout goes to the business itself. The card then reads "To Tony's Pizza,
   * $250.00, if the high in Austin ...", with no kickoff and no customer line.
   */
  cover?: boolean;
  onDetails?: () => void;
};

const Blank = ({ width }: { width: string }) => <span className={`inline-block h-[14px] rounded bg-line align-middle ${width}`} />;

function header(p: ReceiptCardProps): { text: string; dot?: boolean; tone: "plain" | "go" | "grey" } {
  const team = (p.subject ?? "").replace(/^the /i, "").toUpperCase();
  switch (p.state) {
    case "preview":
      return { text: "PREVIEW", tone: "plain" };
    case "open": {
      const left = Math.max((p.maxClaims ?? 0) - (p.claimCount ?? 0), 0);
      return { text: `${left} OF ${p.maxClaims ?? 0} LEFT`, tone: "plain" };
    }
    case "full":
      return { text: "ALL SPOTS TAKEN", tone: "grey" };
    case "closed":
      return { text: "CLOSED", tone: "grey" };
    case "covered":
      return { text: "COVERED", dot: true, tone: "go" };
    case "game-on":
      return { text: "COVERED · GAME ON", dot: true, tone: "go" };
    case "won":
      return { text: team ? `${team} WON` : "IT HAPPENED", tone: "go" };
    case "paid":
      return { text: "✓ PAID", tone: "go" };
    case "lost":
      return { text: "NOT THIS TIME", tone: "grey" };
    case "cancelled":
      return { text: "CANCELLED", tone: "grey" };
    case "review":
      return { text: "CHECKING THE RESULT", tone: "plain" };
  }
}

function resultLine(p: ReceiptCardProps): string | null {
  const subject = capitalize(p.subject ?? "");
  switch (p.state) {
    case "won":
      return p.waiting ? `Your ${usd(p.amount)} is set aside. We're sending it again.` : `Paying you ${usd(p.amount)} now`;
    case "lost":
      return subject ? `${subject} lost. Nothing was owed.` : "It didn't happen. Nothing was owed.";
    case "cancelled":
      return "The game was cancelled. This promo is off.";
    case "review":
      return "The result is being checked. Nothing to do.";
    default:
      return null;
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-4">
      <dt className="label w-[84px] shrink-0">{label}</dt>
      <dd className="min-w-0 text-[15px]">{children}</dd>
    </div>
  );
}

function Front(p: ReceiptCardProps) {
  const head = header(p);
  const grey = head.tone === "grey";
  const line = resultLine(p);
  const showCustomer = p.state !== "open" && p.state !== "full" && p.state !== "closed";
  return (
    <div className={`overflow-hidden rounded-[10px] border border-line bg-card ${grey ? "text-ink/60" : ""}`}>
      <div className="px-5 pt-4">
        <div className="flex items-center justify-between gap-3">
          <span className="label truncate">{p.business?.trim() || "Your place"}</span>
          <span
            className={`num flex shrink-0 items-center gap-1.5 text-[12px] font-medium tracking-[0.08em] ${head.tone === "go" ? "text-go" : grey ? "text-ink/60" : "text-ink"}`}
          >
            {head.dot && <span className="size-2 rounded-full bg-go" />}
            {head.text}
          </span>
        </div>

        <div className="mt-4 flex items-baseline justify-between gap-4">
          <span className="min-w-0 truncate text-[22px] font-semibold leading-7">
            {p.cover ? `To ${p.business?.trim() || "your business"}` : p.item?.trim() || <Blank width="w-24" />}
          </span>
          <span className="num shrink-0 text-[22px] leading-7">{p.amount ? usd(p.amount) : <Blank width="w-14" />}</span>
        </div>
        <p className="mt-1 text-[13px] font-semibold uppercase tracking-[0.06em]">
          {p.condition ? `${p.cover ? "If" : "Free if"} ${p.condition}` : <Blank width="w-40" />}
        </p>
      </div>

      {/* The perforation: a notch on each side with a dashed line between them. */}
      <div className="relative my-4 h-[18px]">
        <span className="absolute -left-[10px] top-0 size-[18px] rounded-full border border-line bg-paper" />
        <span className="absolute -right-[10px] top-0 size-[18px] rounded-full border border-line bg-paper" />
        <span className="absolute left-4 right-4 top-1/2 border-t border-dashed border-line" />
      </div>

      <dl className="space-y-1.5 px-5 pb-4">
        <Row label={p.cover ? "Day" : "Game"}>{p.game ?? <Blank width="w-32" />}</Row>
        {!p.cover && (p.startTime || p.state === "preview") && (
          <Row label="Kickoff">{p.startTime ? <span className="num">{dayTime(p.startTime)}</span> : <Blank width="w-24" />}</Row>
        )}
        {p.cover && p.startTime ? (
          <Row label="Buy by">
            <span className="num">{dayTime(p.startTime)}</span>
          </Row>
        ) : null}
        {showCustomer && !p.cover && (
          <Row label="Customer">
            <span className="num">
              {p.customerNumber ?? 1} of {p.maxClaims ?? 0}
            </span>
          </Row>
        )}
        {line && <p className={`pt-2 text-[15px] ${p.state === "won" ? "font-medium text-go" : ""}`}>{line}</p>}
        {p.onDetails && (
          <button className="pt-2 text-[14px] underline underline-offset-2" onClick={p.onDetails}>
            Details ›
          </button>
        )}
      </dl>
    </div>
  );
}

/** The back of the card: what the customer was paid. Green, because green means Paid. */
function PaidBack(p: ReceiptCardProps) {
  const subject = capitalize(p.subject ?? "");
  return (
    <div className="flex h-full flex-col rounded-[10px] border border-go/30 bg-go-tint px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="label truncate">{p.business?.trim() || "Your place"}</span>
        <span className="num text-[12px] font-medium tracking-[0.08em] text-go">✓ PAID</span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center py-6 text-center">
        <span className="num text-[44px] font-semibold leading-none">{usd(p.amount)}</span>
        <span className="mt-3 text-[15px]">{p.paidAt ? `Paid ${dayTime(p.paidAt)}` : "Paid"}</span>
        <span className="text-[15px] text-ink/60">{subject ? `${subject} won` : "It happened"}</span>
      </div>
      {p.onDetails && (
        <button className="self-start text-[14px] underline underline-offset-2" onClick={p.onDetails}>
          Details ›
        </button>
      )}
    </div>
  );
}

export function ReceiptCard(props: ReceiptCardProps) {
  if (props.state !== "paid") return <Front {...props} />;
  // Paid: the card turns over once. The front (as it was while covered) gives the card its height.
  return (
    <div className="flip">
      <div className="flip-inner is-flipped">
        <div className="flip-face" aria-hidden>
          <Front {...props} state="game-on" onDetails={undefined} />
        </div>
        <div className="flip-face flip-back">
          <PaidBack {...props} />
        </div>
      </div>
    </div>
  );
}
