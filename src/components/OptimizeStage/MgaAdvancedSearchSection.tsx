import { InfoTooltip } from "@/components/InfoTooltip"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { MgaParams } from "@/api/client"
import type { MgaParamsExt } from "@/stores/missionStore"

type MbhConfig = NonNullable<MgaParams["mbh"]>
type PruningConfig = NonNullable<MgaParams["pruning"]>
type HookeJeevesConfig = NonNullable<MbhConfig["hooke_jeeves"]>
type GlobalStallConfig = NonNullable<MbhConfig["global_stall"]>
type MigrationConfig = NonNullable<MbhConfig["migration"]>
type PruningBoundConfig = NonNullable<PruningConfig["bound"]>
type PruningSurrogateConfig = NonNullable<PruningConfig["surrogate"]>

// Extracted verbatim from the old MgaParamsForm.tsx's "Advanced (MGA search
// internals)" disclosure content during the Phase B revision:
// MBH internals, pruning/surrogate/bound, eta_max/min_solar_perihelion_m,
// per-flyby periapsis bound override -- dozens of power-user fields, already
// collapsed-by-default and rarely touched. Deliberately left as this
// existing dark-styled component, reused as-is inside the new paper-native
// MgaParamsFields.tsx's PaperDisclosure wrapper, rather than rebuilt in
// paper style -- see the plan's scope-decision note: rebuilding ~700 lines
// of deeply-nested fields for content this rarely opened isn't worth it
// this pass. Only the outer collapse chrome moved (now owned by the
// caller's PaperDisclosure); this component always renders its content when
// mounted.
export function MgaAdvancedSearchSection({
  params,
  setMgaParams,
  flybyBodies,
  mode,
}: {
  params: MgaParamsExt
  setMgaParams: (params: MgaParamsExt) => void
  flybyBodies: string[]
  mode: "auto" | "manual"
}) {
  const updateMbh = (fields: Partial<MbhConfig>) => setMgaParams({ ...params, mbh: { ...params.mbh, ...fields } })
  const updateHookeJeeves = (fields: Partial<HookeJeevesConfig>) =>
    updateMbh({ hooke_jeeves: { ...params.mbh?.hooke_jeeves, ...fields } })
  const updateGlobalStall = (fields: Partial<GlobalStallConfig>) =>
    updateMbh({
      global_stall: {
        patience: params.mbh?.global_stall?.patience ?? 20,
        margin_frac: params.mbh?.global_stall?.margin_frac ?? 0.3,
        ...fields,
      },
    })
  const updateMigration = (fields: Partial<MigrationConfig>) =>
    updateMbh({ migration: { ...params.mbh?.migration, ...fields } })
  const updatePruning = (fields: Partial<PruningConfig>) =>
    setMgaParams({ ...params, pruning: { ...params.pruning, ...fields } })
  const updateBound = (fields: Partial<PruningBoundConfig>) =>
    updatePruning({ bound: { ...params.pruning?.bound, ...fields } })
  const updateSurrogate = (fields: Partial<PruningSurrogateConfig>) =>
    updatePruning({ surrogate: { ...params.pruning?.surrogate, ...fields } })

  const globalStallEnabled = params.mbh?.global_stall != null
  const boundEnabled = params.pruning?.bound != null

  return (
    <div className="flex flex-col gap-5 rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">
        Everything below is optional. A field left untouched is omitted from the request entirely, so the
        backend's own default applies -- these controls exist for reproducibility and A/B testing, not because
        a run requires them.
      </p>

      {(params.search_method ?? "Mbh") === "Mbh" && (
        <div className="flex flex-col gap-3">
          <Label className="text-sm font-medium">Search method internals (MBH)</Label>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mga-mbh-perturb" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                Perturb fraction
                <InfoTooltip>Fraction of chromosome variables perturbed on each kick. Default: 0.3.</InfoTooltip>
              </Label>
              <Input
                id="mga-mbh-perturb"
                type="number"
                step={0.05}
                min={0}
                max={1}
                value={params.mbh?.perturb_fraction ?? ""}
                placeholder="0.3"
                onChange={(e) => updateMbh({ perturb_fraction: e.target.value === "" ? undefined : Number(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mga-mbh-local-iter" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                Local max iterations
                <InfoTooltip>Max local-descent iterations per hop, for whichever local optimizer is selected below. Default: 500.</InfoTooltip>
              </Label>
              <Input
                id="mga-mbh-local-iter"
                type="number"
                min={1}
                value={params.mbh?.local_max_iter ?? ""}
                placeholder="500"
                onChange={(e) => updateMbh({ local_max_iter: e.target.value === "" ? undefined : Number(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mga-mbh-stop-after" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                Stop after (stagnant hops)
                <InfoTooltip>Terminate a chain after this many consecutive non-improving hops instead of always burning the full hop budget. Blank (default) disables early stop.</InfoTooltip>
              </Label>
              <Input
                id="mga-mbh-stop-after"
                type="number"
                min={1}
                value={params.mbh?.stop_after ?? ""}
                placeholder="disabled"
                onChange={(e) => updateMbh({ stop_after: e.target.value === "" ? null : Number(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mga-mbh-extra-random" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                Extra random chains
                <InfoTooltip>Purely-randomly-initialised chains added alongside the elite seeds (pruning survivors + bidirectional-backfit stitches). 0 (default) means the search relies entirely on the pre-search having found the right basin.</InfoTooltip>
              </Label>
              <Input
                id="mga-mbh-extra-random"
                type="number"
                min={0}
                value={params.mbh?.extra_random_chains ?? ""}
                placeholder="0"
                onChange={(e) => updateMbh({ extra_random_chains: e.target.value === "" ? undefined : Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mga-mbh-local-optimizer" className="inline-flex items-center gap-1.5">
              Local optimizer
              <InfoTooltip>Which local optimizer runs MBH's inner descent step. NelderMead (default) is a full local solve; CompassSearch is a best-of-all-directions pattern search; HookeJeeves is a greedy accept-first-improving pattern search matching real MBH reference implementations' shallow per-hop descent.</InfoTooltip>
            </Label>
            <Select
              value={params.mbh?.local_optimizer ?? "NelderMead"}
              onValueChange={(v) => updateMbh({ local_optimizer: v as MbhConfig["local_optimizer"] })}
            >
              <SelectTrigger id="mga-mbh-local-optimizer" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NelderMead">Nelder-Mead (default)</SelectItem>
                <SelectItem value="CompassSearch">Compass search</SelectItem>
                <SelectItem value="HookeJeeves">Hooke-Jeeves</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {params.mbh?.local_optimizer === "HookeJeeves" && (
            <div className="grid grid-cols-2 gap-3 pl-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mga-hj-fevals" className="text-xs text-muted-foreground">Max fevals/descent</Label>
                <Input
                  id="mga-hj-fevals"
                  type="number"
                  min={1}
                  value={params.mbh?.hooke_jeeves?.max_fevals ?? ""}
                  placeholder="1"
                  onChange={(e) => updateHookeJeeves({ max_fevals: e.target.value === "" ? undefined : Number(e.target.value) })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mga-hj-start-range" className="text-xs text-muted-foreground">Start range</Label>
                <Input
                  id="mga-hj-start-range"
                  type="number"
                  step={0.01}
                  min={0}
                  value={params.mbh?.hooke_jeeves?.start_range ?? ""}
                  placeholder="0.1"
                  onChange={(e) => updateHookeJeeves({ start_range: e.target.value === "" ? undefined : Number(e.target.value) })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mga-hj-stop-range" className="text-xs text-muted-foreground">Stop range</Label>
                <Input
                  id="mga-hj-stop-range"
                  type="number"
                  step={0.001}
                  min={0}
                  value={params.mbh?.hooke_jeeves?.stop_range ?? ""}
                  placeholder="0.01"
                  onChange={(e) => updateHookeJeeves({ stop_range: e.target.value === "" ? undefined : Number(e.target.value) })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mga-hj-reduction" className="text-xs text-muted-foreground">Reduction coeff</Label>
                <Input
                  id="mga-hj-reduction"
                  type="number"
                  step={0.05}
                  min={0}
                  max={1}
                  value={params.mbh?.hooke_jeeves?.reduction_coeff ?? ""}
                  placeholder="0.5"
                  onChange={(e) => updateHookeJeeves({ reduction_coeff: e.target.value === "" ? undefined : Number(e.target.value) })}
                />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Checkbox
              id="mga-global-stall-enabled"
              checked={globalStallEnabled}
              onCheckedChange={(checked) =>
                updateMbh({ global_stall: checked ? { patience: 20, margin_frac: 0.3 } : null })
              }
            />
            <Label htmlFor="mga-global-stall-enabled" className="inline-flex items-center gap-1.5">
              Global stall early-stop
              <InfoTooltip>Abandon a chain past "patience" hops if it's still worse than the best result any chain has found so far by more than "margin frac". Off by default.</InfoTooltip>
            </Label>
          </div>
          {globalStallEnabled && (
            <div className="grid grid-cols-2 gap-3 pl-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mga-gs-patience" className="text-xs text-muted-foreground">Patience (hops)</Label>
                <Input
                  id="mga-gs-patience"
                  type="number"
                  min={1}
                  value={params.mbh?.global_stall?.patience ?? 20}
                  onChange={(e) => updateGlobalStall({ patience: Number(e.target.value) })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mga-gs-margin" className="text-xs text-muted-foreground">Margin fraction</Label>
                <Input
                  id="mga-gs-margin"
                  type="number"
                  step={0.05}
                  min={0}
                  value={params.mbh?.global_stall?.margin_frac ?? 0.3}
                  onChange={(e) => updateGlobalStall({ margin_frac: Number(e.target.value) })}
                />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Checkbox
              id="mga-migration-enabled"
              checked={params.mbh?.migration?.enabled ?? true}
              onCheckedChange={(checked) => updateMigration({ enabled: checked === true })}
            />
            <Label htmlFor="mga-migration-enabled" className="inline-flex items-center gap-1.5">
              Archipelago migration (backend default: on)
              <InfoTooltip>Every "interval" hops, a chain whose incumbent is worse than the live global best by more than "margin frac" receives the global best as its new incumbent and keeps hopping from there -- repurposes a losing chain instead of leaving it stuck.</InfoTooltip>
            </Label>
          </div>
          {(params.mbh?.migration?.enabled ?? true) && (
            <div className="grid grid-cols-2 gap-3 pl-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mga-mig-interval" className="text-xs text-muted-foreground">Interval (hops)</Label>
                <Input
                  id="mga-mig-interval"
                  type="number"
                  min={1}
                  value={params.mbh?.migration?.interval ?? 10}
                  onChange={(e) => updateMigration({ interval: Number(e.target.value) })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mga-mig-margin" className="text-xs text-muted-foreground">Margin fraction</Label>
                <Input
                  id="mga-mig-margin"
                  type="number"
                  step={0.05}
                  min={0}
                  value={params.mbh?.migration?.margin_frac ?? 0.3}
                  onChange={(e) => updateMigration({ margin_frac: Number(e.target.value) })}
                />
              </div>
            </div>
          )}
        </div>
      )}

      <Separator />

      <div className="flex flex-col gap-3">
        <Label className="text-sm font-medium">Pruning (leg-by-leg pre-search)</Label>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mga-pr-samples0" className="text-xs text-muted-foreground">Samples at level 0</Label>
            <Input
              id="mga-pr-samples0"
              type="number"
              min={1}
              value={params.pruning?.samples_level0 ?? ""}
              placeholder="2000"
              onChange={(e) => updatePruning({ samples_level0: e.target.value === "" ? undefined : Number(e.target.value) })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mga-pr-children" className="text-xs text-muted-foreground">Children/survivor</Label>
            <Input
              id="mga-pr-children"
              type="number"
              min={1}
              value={params.pruning?.children_per_survivor ?? ""}
              placeholder="50"
              onChange={(e) => updatePruning({ children_per_survivor: e.target.value === "" ? undefined : Number(e.target.value) })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mga-pr-max-survivors" className="text-xs text-muted-foreground">Max survivors/level</Label>
            <Input
              id="mga-pr-max-survivors"
              type="number"
              min={1}
              value={params.pruning?.max_survivors_per_level ?? ""}
              placeholder="40"
              onChange={(e) => updatePruning({ max_survivors_per_level: e.target.value === "" ? undefined : Number(e.target.value) })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mga-pr-threshold" className="text-xs text-muted-foreground">Threshold factor</Label>
            <Input
              id="mga-pr-threshold"
              type="number"
              step={0.5}
              min={1}
              value={params.pruning?.threshold_factor ?? ""}
              placeholder="3.0"
              onChange={(e) => updatePruning({ threshold_factor: e.target.value === "" ? undefined : Number(e.target.value) })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mga-pr-n-seeds" className="text-xs text-muted-foreground">Elite seeds</Label>
            <Input
              id="mga-pr-n-seeds"
              type="number"
              min={1}
              value={params.pruning?.n_seeds ?? ""}
              placeholder="8"
              onChange={(e) => updatePruning({ n_seeds: e.target.value === "" ? undefined : Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="mga-pr-bidirectional"
            checked={params.pruning?.bidirectional ?? true}
            onCheckedChange={(checked) => updatePruning({ bidirectional: checked === true })}
          />
          <Label htmlFor="mga-pr-bidirectional" className="inline-flex items-center gap-1.5">
            Bidirectional ("meet in the middle") (backend default: on)
            <InfoTooltip>Alongside forward leg-by-leg pruning, run a mirror-image backward pass from the target and inject the best stitched full chromosomes as additional seeds.</InfoTooltip>
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="mga-surrogate-enabled"
            checked={params.pruning?.surrogate?.enabled ?? true}
            onCheckedChange={(checked) => updateSurrogate({ enabled: checked === true })}
          />
          <Label htmlFor="mga-surrogate-enabled" className="inline-flex items-center gap-1.5">
            Surrogate-assisted sampling (backend default: on)
            <InfoTooltip>Fits a per-level RBF model to (child variables → added cost) pairs and only really-evaluates the best-predicted of several oversampled candidates per slot. Beat plain sampling on every tested branch.</InfoTooltip>
          </Label>
        </div>
        {(params.pruning?.surrogate?.enabled ?? true) && (
          <div className="grid grid-cols-3 gap-3 pl-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mga-sur-oversample" className="text-xs text-muted-foreground">Oversample factor</Label>
              <Input
                id="mga-sur-oversample"
                type="number"
                min={1}
                value={params.pruning?.surrogate?.oversample_factor ?? 4}
                onChange={(e) => updateSurrogate({ oversample_factor: Number(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mga-sur-min-fit" className="text-xs text-muted-foreground">Min fit samples</Label>
              <Input
                id="mga-sur-min-fit"
                type="number"
                min={1}
                value={params.pruning?.surrogate?.min_fit_samples ?? 60}
                onChange={(e) => updateSurrogate({ min_fit_samples: Number(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mga-sur-length-scale" className="text-xs text-muted-foreground">Length scale</Label>
              <Input
                id="mga-sur-length-scale"
                type="number"
                step={0.05}
                min={0}
                value={params.pruning?.surrogate?.length_scale ?? 0.3}
                onChange={(e) => updateSurrogate({ length_scale: Number(e.target.value) })}
              />
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Checkbox
            id="mga-bound-enabled"
            checked={boundEnabled}
            onCheckedChange={(checked) =>
              updatePruning({
                bound: checked
                  ? { safety_frac: 0.5, epoch_bins: 24, vinf_bins: 12, samples_per_split: 3000 }
                  : null,
              })
            }
          />
          <Label htmlFor="mga-bound-enabled" className="inline-flex items-center gap-1.5">
            Remaining-cost bound (experimental, off by default)
            <InfoTooltip>Branch-and-bound pruning via a sampled backward suffix-cost table (A* style f = g + h). Real A/B testing found this sometimes helps and sometimes regresses on its own -- and enabling it together with Surrogate sampling got WORSE, not better, at larger search budgets. Do not enable both without testing.</InfoTooltip>
          </Label>
        </div>
        {boundEnabled && (params.pruning?.surrogate?.enabled ?? true) && (
          <p className="text-xs text-amber-500 pl-3">
            Caution: Surrogate sampling is also enabled. A/B testing found this combination performs worse than
            either feature alone, and gets worse (not better) with more search budget. Consider disabling
            Surrogate sampling above while testing the bound, or leave the bound off.
          </p>
        )}
        {boundEnabled && (
          <div className="grid grid-cols-2 gap-3 pl-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mga-bd-safety" className="text-xs text-muted-foreground">Safety fraction</Label>
              <Input
                id="mga-bd-safety"
                type="number"
                step={0.05}
                min={0}
                max={1}
                value={params.pruning?.bound?.safety_frac ?? 0.5}
                onChange={(e) => updateBound({ safety_frac: Number(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mga-bd-samples" className="text-xs text-muted-foreground">Samples/split</Label>
              <Input
                id="mga-bd-samples"
                type="number"
                min={1}
                value={params.pruning?.bound?.samples_per_split ?? 3000}
                onChange={(e) => updateBound({ samples_per_split: Number(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mga-bd-epoch-bins" className="text-xs text-muted-foreground">Epoch bins</Label>
              <Input
                id="mga-bd-epoch-bins"
                type="number"
                min={1}
                value={params.pruning?.bound?.epoch_bins ?? 24}
                onChange={(e) => updateBound({ epoch_bins: Number(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mga-bd-vinf-bins" className="text-xs text-muted-foreground">v∞ bins</Label>
              <Input
                id="mga-bd-vinf-bins"
                type="number"
                min={1}
                value={params.pruning?.bound?.vinf_bins ?? 12}
                onChange={(e) => updateBound({ vinf_bins: Number(e.target.value) })}
              />
            </div>
          </div>
        )}
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <Label className="text-sm font-medium">Bounds</Label>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mga-eta-max" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              Eta max (DSM timing)
              <InfoTooltip>Upper bound override for every leg's DSM-timing fraction η. Default (blank) keeps the historical 0.99 bound. The real GTOP Cassini-2 problem uses 0.9.</InfoTooltip>
            </Label>
            <Input
              id="mga-eta-max"
              type="number"
              step={0.01}
              min={0}
              max={1}
              value={params.eta_max ?? ""}
              placeholder="0.99"
              onChange={(e) => setMgaParams({ ...params, eta_max: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mga-min-perihelion" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              Min solar perihelion (m)
              <InfoTooltip>Minimum heliocentric perihelion permitted for either sub-arc of any leg -- rejects chromosomes whose orbit dives unrealistically close to the Sun. Default (blank): 0.2 AU (~2.99e10 m).</InfoTooltip>
            </Label>
            <Input
              id="mga-min-perihelion"
              type="number"
              min={0}
              value={params.min_solar_perihelion_m ?? ""}
              placeholder="2.99e10"
              onChange={(e) => setMgaParams({ ...params, min_solar_perihelion_m: e.target.value === "" ? undefined : Number(e.target.value) })}
            />
          </div>
        </div>

        {mode === "manual" && flybyBodies.length > 0 && (
          <div className="flex flex-col gap-2">
            <Label className="inline-flex items-center gap-1.5">
              Per-flyby periapsis bound override (× body radius)
              <InfoTooltip>[min, max] periapsis bound per intermediate flyby, as a multiple of that flyby body's own radius. Default (blank row) keeps the historical uniform (1.05, 300.0) bound. The real GTOP Cassini-2 problem uses body-specific bounds (e.g. Venus [1.05, 6], Earth [1.15, 6.5], Jupiter [1.7, 291]).</InfoTooltip>
            </Label>
            <div className="flex flex-col gap-1.5">
              {flybyBodies.map((name, idx) => {
                const pair = params.rp_norm_bounds?.[idx]
                return (
                  <div key={`${name}-${idx}`} className="grid grid-cols-[1fr_auto_auto] items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {idx + 1}. {name}
                    </span>
                    <Input
                      type="number"
                      className="w-24"
                      step={0.1}
                      value={pair?.[0] ?? ""}
                      placeholder="1.05"
                      onChange={(e) => {
                        const next = (params.rp_norm_bounds ?? flybyBodies.map(() => [1.05, 300])).map((p, i) =>
                          i === idx ? [Number(e.target.value), p?.[1] ?? 300] : p,
                        )
                        setMgaParams({ ...params, rp_norm_bounds: next })
                      }}
                    />
                    <Input
                      type="number"
                      className="w-24"
                      step={1}
                      value={pair?.[1] ?? ""}
                      placeholder="300"
                      onChange={(e) => {
                        const next = (params.rp_norm_bounds ?? flybyBodies.map(() => [1.05, 300])).map((p, i) =>
                          i === idx ? [p?.[0] ?? 1.05, Number(e.target.value)] : p,
                        )
                        setMgaParams({ ...params, rp_norm_bounds: next })
                      }}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
