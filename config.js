// Safe to publish. ESPN loading goes through the league-history Supabase function
// (deployed to the same Supabase project as Fantasy Injury Assist, see README).
window.FLH_CONFIG = {
  SUPABASE_URL: "https://idwpxslgbtudrkxxxyqr.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_qqbUv6jhul94p4DHi93hZw_h7TLngnC",
  BMC_URL: "https://buymeacoffee.com/jrkline1116",

  // Google AdSense. Leave blank and no ads load.
  // ADSENSE_CLIENT: your publisher ID, like "ca-pub-1234567890123456" (AdSense → Account → Account information).
  // With only the client filled in, AdSense "Auto ads" places ads itself (turn it on in AdSense → Ads → By site).
  // Fill in slot IDs (AdSense → Ads → By ad unit → Display ads → copy data-ad-slot) for fixed banners:
  //   top: under the tabs · bottom: above the footer · side: tall ads in the margins on wide screens
  ADSENSE_CLIENT: "",
  ADSENSE_SLOTS: { top: "", bottom: "", side: "" },
};
